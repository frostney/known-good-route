import { realpath } from "node:fs/promises";
import { command } from "./github-live.ts";
import { fixtureCommand, fixtureEnvironment } from "./github-fixture-target.ts";
import { runGuardedStack, stackPushAdmission } from "./stack-push-guard.ts";
import { appendExistingPR } from "./stack-append.ts";
import { createDraftPR } from "./stack-pr-create.ts";
import type { StackPublicationContext, StackPublicationDriver, PublicationSnapshot } from "./stack-publication.ts";

export async function resolveLocalStackBranches(rows: any[], readHead: (branch: string) => Promise<string>) {
  return Promise.all(rows.map(async b => {
    const head = await readHead(b.name);
    if (!/^[0-9a-f]{40}$/.test(head) || (b.head != null && b.head !== head))
      throw Error("Local branch ref differs from stack metadata");
    return { branch: b.name, head, unsafe: Boolean(b.needsRebase || b.isMerged || b.isQueued) };
  }));
}

export function publicationPR(p: any, repositoryId: number) {
  if (p?.head?.repo?.id !== repositoryId || p?.base?.repo?.id !== repositoryId ||
      typeof p?.head?.ref !== "string" || !p.head.ref || !Number.isSafeInteger(p?.number) || p.number <= 0 || !/^[0-9a-f]{40}$/.test(p.head.sha) ||
      !/^[0-9a-f]{40}$/.test(p.base.sha) || typeof p.base.ref !== "string" ||
      !["open", "closed"].includes(p.state) || typeof p.draft !== "boolean" || typeof p.merged !== "boolean" ||
      !(p.auto_merge === null || typeof p.auto_merge === "object" && p.auto_merge !== null && !Array.isArray(p.auto_merge)))
    throw Error("PR identity or publication metadata is incomplete");
  return { pr: p.number, branch: p.head.ref, head: p.head.sha, open: p.state === "open", merged: p.merged, draft: p.draft,
    baseRef: p.base.ref, baseHead: p.base.sha, autoMerge: p.auto_merge !== null };
}

export function publicationCandidate(p: any, c: StackPublicationContext) {
  const { branch, ...candidate } = publicationPR(p, c.repositoryId);
  if (branch !== c.branch) throw Error("PR candidate branch differs from admission");
  return candidate;
}

export function stablePublicationMembers(first: any[], second: any[], repositoryId: number) {
  const before = first.map(p => publicationPR(p, repositoryId)), after = second.map(p => publicationPR(p, repositoryId));
  if (JSON.stringify(before) !== JSON.stringify(after)) throw Error("PR metadata changed during observation");
  return after;
}

function candidateList(pages: any) {
  if (!Array.isArray(pages) || pages.some(p => !Array.isArray(p))) throw Error("Incomplete PR candidate pagination");
  const candidates = pages.flat();
  if (candidates.some(p => !Number.isSafeInteger(p?.number) || p.number <= 0)) throw Error("Invalid PR candidate number");
  if (new Set(candidates.map(p => p.number)).size !== candidates.length) throw Error("Duplicated candidate pages");
  if (candidates.length > 1) throw Error("Multiple PRs use the intended branch");
  return candidates;
}

function remoteHeads(output: string) {
  const heads: Record<string, string> = {};
  for (const row of output.split("\n").filter(Boolean)) {
    const [head, ref, extra] = row.split("\t");
    if (!/^[0-9a-f]{40}$/.test(head ?? "") || !ref?.startsWith("refs/heads/") || !ref.slice(11) || extra !== undefined ||
        Object.hasOwn(heads, ref.slice(11))) throw Error("Malformed or duplicated remote branch lease");
    heads[ref.slice(11)] = head!;
  }
  return Object.fromEntries(Object.entries(heads).sort(([a], [b]) => a.localeCompare(b)));
}

export async function observeStackPublication(c: StackPublicationContext, run: typeof command = command): Promise<PublicationSnapshot> {
  run = fixtureCommand(c.repository, run);
  const git = (...args: string[]) => run(["git", ...args], c.directory);
  const gh = (...args: string[]) => run(["gh", ...args], c.directory);
  const api = async (path: string) => JSON.parse(await gh("api", `repos/${c.repository}${path}`));
  const readCandidates = () => gh("api", `repos/${c.repository}/pulls?state=all&head=${encodeURIComponent(c.repository.split("/")[0] + ":" + c.branch)}&per_page=100`, "--paginate", "--slurp").then(JSON.parse);
  const readBranchHeads = () => git("ls-remote", "--heads", "origin", ...[c.baseRef, ...c.prefix.map(p => p.branch), c.branch].map(b => `refs/heads/${b}`));
  const projection = (s: any) => ({ id: s.id, number: s.number, base: s.base.ref, open: s.open,
    members: s.pull_requests.map((p: any) => ({ pr: p.number, branch: p.head.ref, head: p.head.sha })) });
  const [repository, raw, local, directory, origin, base, commit, status, changes, others] = await Promise.all([
    api(""), api(`/stacks/${c.stack}`), gh("stack", "view", "--json").then(JSON.parse), realpath(c.directory),
    git("remote", "get-url", "origin"), git("rev-parse", c.baseRef), git("show", "-s", "--format=%H%n%T%n%P%n%B", "HEAD"),
    git("status", "--porcelain"), git("diff", "HEAD", "--name-only"), git("ls-files", "--others", "--exclude-standard"),
  ]);
  const [pulls, branchHeads, candidates, localBranches] = await Promise.all([
    Promise.all(raw.pull_requests.map((p: any) => api(`/pulls/${p.number}`))),
    readBranchHeads(),
    readCandidates(),
    resolveLocalStackBranches(local.branches, branch => git("rev-parse", "--verify", `refs/heads/${branch}`)),
  ]);
  const allCandidates = candidateList(candidates);
  const readCandidateDetails = () => Promise.all(allCandidates.map(async p => {
    const detail = await api(`/pulls/${p.number}`);
    if (detail.number !== p.number) throw Error("Candidate detail identity changed");
    return publicationCandidate(detail, c);
  }));
  const candidateDetails = await readCandidateDetails();
  const stableMembers = stablePublicationMembers(pulls,
    await Promise.all(raw.pull_requests.map((p: any) => api(`/pulls/${p.number}`))), c.repositoryId);
  if (JSON.stringify(candidateDetails) !== JSON.stringify(await readCandidateDetails()))
    throw Error("PR candidate metadata changed during observation");
  // Close the remote observation only after complete PR inspection. Earlier
  // parallel reads cannot detect membership/ref changes made during it.
  const [rawAfter, candidatesAfter, branchHeadsAfter] = await Promise.all([
    api(`/stacks/${c.stack}`), readCandidates(), readBranchHeads(),
  ]);
  if (JSON.stringify(projection(raw)) !== JSON.stringify(projection(rawAfter))) throw Error("Native topology changed during observation");
  if (JSON.stringify(allCandidates.map(p => p.number)) !== JSON.stringify(candidateList(candidatesAfter).map(p => p.number)))
    throw Error("PR candidate membership changed during observation");
  const heads = remoteHeads(branchHeads);
  if (JSON.stringify(heads) !== JSON.stringify(remoteHeads(branchHeadsAfter))) throw Error("Remote branch leases changed during observation");
  const [oid, tree, parents, ...message] = commit.split("\n");
  return { repository: { id: repository.id, full_name: repository.full_name, private: repository.private }, directory, origin,
    local: { trunk: local.trunk, base, current: local.currentBranch,
      branches: localBranches },
    remote: { stack: raw.number, id: raw.id, baseRef: raw.base.ref, base: heads[c.baseRef] ?? "", open: raw.open,
      members: stableMembers.map((observed, i) => {
        const member = raw.pull_requests[i];
        if (observed.pr !== member.number || observed.head !== member.head.sha || observed.branch !== member.head.ref)
          throw Error("Member PR identity differs from native topology");
        return observed;
      }), heads,
      candidates: candidateDetails },
    head: { sha: oid!, tree: tree!, parents: parents ? parents.split(" ") : [], message: message.join("\n").trimEnd() },
    dirty: Boolean(status), changed: changes.split("\n").filter(Boolean), untracked: others.split("\n").filter(Boolean) };
}

export function nativeStackPublicationDriver(c: StackPublicationContext, pythonBinary?: string,
  options: { legacySubmit?: boolean } = {}): StackPublicationDriver {
  const run = fixtureCommand(c.repository);
  const git = (...args: string[]) => run(["git", ...args], c.directory);
  const gh = (...args: string[]) => run(["gh", ...args], c.directory);
  const guarded = async (head: string, phase: "submit" | "link", args: string[]) => {
    await runGuardedStack(stackPushAdmission(c, head, phase), args, pythonBinary, fixtureEnvironment(c.repository));
  };
  return {
    async observe(): Promise<PublicationSnapshot> {
      return observeStackPublication(c);
    },
    async add(branch) { await gh("stack", "add", branch); },
    async stage(paths) { await git("add", "--", ...paths); return git("write-tree"); },
    async commit(message) { await git("commit", "-m", message); },
    async submit(head) { await guarded(head, "submit", options.legacySubmit
      ? ["submit", "--auto", "--remote", "origin"] : ["push", "--remote", "origin"]); },
    async createPR(head) { await createDraftPR(c, head); },
    async link(pr, head) {
      if (pr === undefined) throw Error("Create and verify a detached PR before appending it");
      await appendExistingPR(c, pr, head);
    },
  };
}

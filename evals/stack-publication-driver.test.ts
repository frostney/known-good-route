import { expect, test } from "bun:test";
import { publicationCandidate, publicationPR, resolveLocalStackBranches, stablePublicationMembers } from "./stack-publication-driver.ts";
import type { StackPublicationContext } from "./stack-publication.ts";

test("new empty native layer resolves its actual Git head when gh stack omits head", async () => {
  const head = "a".repeat(40), seen: string[] = [];
  const result = await resolveLocalStackBranches([{ name: "codex/eval-parent", head }, { name: "codex/eval-empty", base: head }],
    async branch => { seen.push(branch); return head; });
  expect(seen).toEqual(["codex/eval-parent", "codex/eval-empty"]);
  expect(result.map(b => b.head)).toEqual([head, head]);
});
test("a stale extension head cannot override the actual local Git ref", async () => {
  await expect(resolveLocalStackBranches([{ name: "codex/eval-layer", head: "a".repeat(40) }], async () => "b".repeat(40))).rejects.toThrow("differs");
});
test("missing or invalid Git refs cannot establish an empty layer head", async () => {
  await expect(resolveLocalStackBranches([{ name: "codex/eval-empty" }], async () => "")).rejects.toThrow("differs");
  await expect(resolveLocalStackBranches([{ name: "codex/eval-empty" }], async () => { throw Error("missing ref"); })).rejects.toThrow("missing ref");
});
test("candidate publication policy comes from complete repository-bound PR details", () => {
  const context = { branch: "codex/eval-fix", repositoryId: 42 } as StackPublicationContext;
  const p = { number: 8, head: { ref: context.branch, sha: "a".repeat(40), repo: { id: 42 } },
    base: { ref: "codex/eval-parent", sha: "b".repeat(40), repo: { id: 42 } }, draft: true, merged: false, state: "open", auto_merge: null };
  expect(publicationCandidate(p, context)).toMatchObject({ draft: true, autoMerge: false, baseRef: p.base.ref, baseHead: p.base.sha });
  for (const field of ["draft", "merged", "auto_merge", "base"]) {
    const incomplete: any = structuredClone(p); delete incomplete[field];
    expect(() => publicationCandidate(incomplete, context)).toThrow("incomplete");
  }
  expect(() => publicationCandidate({ ...p, base: { ...p.base, repo: { id: 999 } } }, context)).toThrow("incomplete");
  expect(publicationCandidate({ ...p, auto_merge: { enabled_by: { login: "fixture" } } }, context).autoMerge).toBe(true);
});
test("prefix PR observations reject missing or malformed base and merge metadata", () => {
  const p = { number: 1, head: { ref: "codex/eval-parent", sha: "a".repeat(40), repo: { id: 42 } },
    base: { ref: "main", sha: "b".repeat(40), repo: { id: 42 } }, draft: false, merged: false, state: "open", auto_merge: null };
  expect(publicationPR(p, 42)).toMatchObject({ branch: p.head.ref, baseRef: "main", baseHead: p.base.sha, autoMerge: false });
  for (const patch of [{ base: undefined }, { merged: undefined }, { draft: undefined }, { auto_merge: undefined }, { auto_merge: [] },
    { head: { ...p.head, repo: { id: 999 } } }]) expect(() => publicationPR({ ...p, ...patch }, 42)).toThrow("incomplete");
  expect(() => publicationPR(null, 42)).toThrow("incomplete");
});
test("PR metadata must remain consistent across the observation window", () => {
  const p = { number: 1, head: { ref: "codex/eval-parent", sha: "a".repeat(40), repo: { id: 42 } },
    base: { ref: "main", sha: "b".repeat(40), repo: { id: 42 } }, draft: true, merged: false, state: "open", auto_merge: null };
  for (const patch of [{ base: { ...p.base, ref: "changed" } }, { base: { ...p.base, sha: "c".repeat(40) } },
    { draft: false }, { auto_merge: { enabled_by: {} } }, { head: { ...p.head, sha: "c".repeat(40) } }])
    expect(() => stablePublicationMembers([p], [{ ...p, ...patch }], 42)).toThrow("metadata changed");
  expect(stablePublicationMembers([p], [{ ...p, title: "Unrelated title edit" }], 42)).toEqual([publicationPR(p, 42)]);
});

// Exercise the actual observer with a transport that changes external state
// during PR inspection, before its closing reads. No GitHub writes are needed.
async function observationFixture(change: string) {
  const { observeStackPublication } = await import("./stack-publication-driver.ts");
  const directory = await import("node:fs/promises").then(fs => fs.realpath(process.cwd()));
  const c = { directory, repository: "frostney/kgr-eval-20260906-window", repositoryId: 42,
    stack: 3, stackId: 43, baseRef: "main", base: "b".repeat(40), branch: "codex/eval-fix",
    prefix: [{ pr: 1, branch: "codex/eval-parent", head: "a".repeat(40) }] } satisfies StackPublicationContext;
  const parent = { number: 1, head: { ref: c.prefix[0]!.branch, sha: c.prefix[0]!.head, repo: { id: 42 } },
    base: { ref: c.baseRef, sha: c.base, repo: { id: 42 } }, draft: true, merged: false, state: "open", auto_merge: null };
  const candidate = { ...parent, number: 2, head: { ...parent.head, ref: c.branch, sha: "c".repeat(40) },
    base: { ...parent.base, ref: parent.head.ref, sha: parent.head.sha } };
  const topology = { id: 43, number: 3, base: { ref: "main" }, open: true, pull_requests: [parent] };
  const detached = change.startsWith("detached-");
  let inspected = false, parentReads = 0, candidateReads = 0;
  const calls: string[][] = [];
  const promise = observeStackPublication(c, async (argv, _cwd, _input, environment) => {
    expect(environment?.GH_HOST).toBe("github.com");
    expect(environment?.GH_REPO).toBe(`github.com/${c.repository}`);
    if (argv[0] === "gh" && argv[1] === "api") expect(argv.slice(-2)).toEqual(["--hostname", "github.com"]);
    calls.push(argv);
    if (argv[0] === "git") {
      if (argv[1] === "remote") return `https://github.com/${c.repository}.git`;
      if (argv[1] === "rev-parse") return argv[2] === "--verify" ? parent.head.sha : c.base;
      if (argv[1] === "show") return `${parent.head.sha}\n${"d".repeat(40)}\n${c.base}\nfixture`;
      if (["status", "diff", "ls-files"].includes(argv[1]!)) return "";
      if (argv[1] === "ls-remote") {
        const rows = [`${c.base}\trefs/heads/main`, `${parent.head.sha}\trefs/heads/${parent.head.ref}`];
        if (inspected && change === "lease") rows[0] = `${"e".repeat(40)}\trefs/heads/main`;
        if (inspected && change === "malformed-lease") rows[0] = `invalid\trefs/heads/main`;
        if (inspected && change === "duplicate-lease") rows.push(rows[0]!);
        return (inspected && change === "reordered" ? rows.reverse() : rows).join("\n");
      }
    }
    if (argv[0] === "gh" && argv[1] === "stack") return JSON.stringify({ trunk: "main", currentBranch: parent.head.ref,
      branches: [{ name: parent.head.ref, head: parent.head.sha }] });
    if (argv[0] === "gh" && argv[1] === "api") {
      const path = argv[2]!;
      if (path === `repos/${c.repository}`) return JSON.stringify({ id: 42, full_name: c.repository, private: true });
      if (path.endsWith("/stacks/3")) return JSON.stringify(inspected && change === "topology"
        ? { ...topology, pull_requests: [parent, candidate] } : topology);
      if (path.includes("/pulls?")) {
        const rows = detached ? [candidate] : [];
        if (inspected && change === "candidate") rows.push(candidate);
        if (inspected && change === "detached-duplicate") rows.push({ ...candidate, number: 3 });
        if (inspected && change === "detached-removed") rows.length = 0;
        return JSON.stringify([rows]);
      }
      if (path.endsWith("/pulls/1")) {
        parentReads++;
        if (parentReads === 2) inspected = true;
        return JSON.stringify(parent);
      }
      if (path.endsWith("/pulls/2")) {
        candidateReads++;
        return JSON.stringify(inspected && change === "detached-policy" ? { ...candidate, draft: false } : candidate);
      }
    }
    throw Error(`Unexpected observation command: ${argv.join(" ")}`);
  });
  return { promise, calls, reads: () => ({ parentReads, candidateReads }) };
}

test("closing topology and candidate reads detect changes made during PR inspection", async () => {
  for (const [change, error] of [["topology", "Native topology changed"], ["candidate", "candidate membership changed"],
    ["detached-duplicate", "Multiple PRs"], ["detached-removed", "candidate membership changed"]]) {
    const fixture = await observationFixture(change!);
    await expect(fixture.promise).rejects.toThrow(error!);
    expect(fixture.reads().parentReads).toBe(2);
    expect(fixture.calls.every(c => c[0] === "git" || c[1] === "api" || c.slice(1).join(" ") === "stack view --json")).toBe(true);
  }
});

test("a detached candidate's policy is rechecked before closing observation", async () => {
  const fixture = await observationFixture("detached-policy");
  await expect(fixture.promise).rejects.toThrow("candidate metadata changed");
  expect(fixture.reads()).toEqual({ parentReads: 2, candidateReads: 2 });
});

test("closing branch reads reject movement and malformed leases but accept ordering changes", async () => {
  for (const change of ["lease", "malformed-lease", "duplicate-lease"]) {
    const fixture = await observationFixture(change);
    await expect(fixture.promise).rejects.toThrow(change === "lease" ? "leases changed" : "Malformed or duplicated");
  }
  const stable = await observationFixture("reordered");
  expect((await stable.promise).remote.members.map(p => p.pr)).toEqual([1]);
});

test("stable detached candidates survive the complete observation window", async () => {
  const fixture = await observationFixture("detached-stable");
  expect((await fixture.promise).remote.candidates).toMatchObject([{ pr: 2, draft: true, autoMerge: false }]);
  expect(fixture.reads()).toEqual({ parentReads: 2, candidateReads: 2 });
});

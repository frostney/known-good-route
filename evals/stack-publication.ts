import { join } from "node:path";
import { z } from "zod";
import { issueDigest } from "./issue-receipt.ts";
import { claimOperation, matchingIntent, readOperationIntent } from "./operation-intent.ts";
import { recordPublicationExecution } from "./publication-execution.ts";
import type { OwnedProcessGroup } from "./process-group.ts";

const sha = z.string().regex(/^[0-9a-f]{40}$/);
const branch = z.string().regex(/^codex\/eval-[a-z0-9-]+$/);
const contextSchema = z.object({
  repository: z.string().regex(/^frostney\/kgr-eval-\d{8}-[a-z0-9-]+$/), repositoryId: z.number().int().positive(),
  directory: z.string().startsWith("/"), stack: z.number().int().positive(), stackId: z.number().int().positive(),
  baseRef: z.string().min(1), base: sha, branch,
  prefix: z.array(z.object({ pr: z.number().int().positive(), branch, head: sha }).strict()).min(1),
}).strict();
export type StackPublicationContext = z.infer<typeof contextSchema>;
export interface PublicationSnapshot {
  repository: { id: number; full_name: string; private: boolean };
  directory: string; origin: string;
  local: { trunk: string; base: string; current: string; branches: { branch: string; head: string; unsafe: boolean }[] };
  remote: { stack: number; id: number; baseRef: string; base: string; open: boolean;
    members: { pr: number; branch: string; head: string; open: boolean; merged: boolean; draft: boolean;
      baseRef: string; baseHead: string; autoMerge: boolean }[];
    heads: Record<string, string>; candidates: { pr: number; head: string; open: boolean; merged: boolean;
      draft: boolean; baseRef: string; baseHead: string; autoMerge: boolean }[] };
  head: { sha: string; tree: string; parents: string[]; message: string };
  dirty: boolean; changed: string[]; untracked: string[];
}
export interface StackPublicationDriver {
  observe(): Promise<PublicationSnapshot>;
  add(branch: string): Promise<void>;
  stage(paths: string[]): Promise<string>;
  commit(message: string): Promise<void>;
  submit(head: string): Promise<void>;
  createPR?(head: string): Promise<void>;
  link?(pr: number | undefined, head: string): Promise<void>;
}
export type PublicationStep = "branch" | "commit" | "submit";
export interface PublicationOutcome { state: "verified" | "pending"; step: PublicationStep; snapshot: PublicationSnapshot; head?: string; pr?: number; reason?: string }
const admissionSchema = z.object({ revision: z.string().min(1), reviewAttempt: z.string().min(1), gateDigest: z.string().min(1) }).strict();
export type CommitAdmission = z.infer<typeof admissionSchema>;
const commitSchema = z.object({ kind: z.literal("commit"), context: contextSchema, tree: sha,
  paths: z.array(z.string().min(1)).min(1), message: z.string().min(1), admission: admissionSchema }).strict();

export function stackPublisher(context: StackPublicationContext, driver: StackPublicationDriver, evidence: string,
  hooks: { afterClaim?: (step: PublicationStep) => Promise<void>; afterAction?: (step: PublicationStep) => Promise<void>; executionOwner?: OwnedProcessGroup } = {}) {
  const c = contextSchema.parse(context), parent = c.prefix.at(-1)!;
  const path = (step: PublicationStep) => join(evidence, `${step}-intent.json`);
  const branchRequest = { kind: "branch", context: c };
  const assert = (ok: unknown, message: string) => { if (!ok) throw Error(`Stack publication invalidated: ${message}`); };
  function scoped(s: PublicationSnapshot) {
    assert(s.repository.id === c.repositoryId && s.repository.full_name === c.repository && s.repository.private &&
      s.directory === c.directory && s.origin === `https://github.com/${c.repository}.git`, "repository or checkout identity changed");
    assert(s.local.trunk === c.baseRef && s.local.base === c.base && s.remote.baseRef === c.baseRef && s.remote.base === c.base &&
      s.remote.id === c.stackId && s.remote.stack === c.stack && s.remote.open, "stack or base identity changed");
    assert([c.prefix.length, c.prefix.length + 1].includes(s.local.branches.length) &&
      [c.prefix.length, c.prefix.length + 1].includes(s.remote.members.length), "unexpected stack membership");
    for (const [i, p] of c.prefix.entries()) {
      const l = s.local.branches[i], r = s.remote.members[i];
      assert(l?.branch === p.branch && l.head === p.head && !l.unsafe && r?.pr === p.pr && r.branch === p.branch &&
        r.head === p.head && r.open && !r.merged && s.remote.heads[p.branch] === p.head, "original member or lease changed");
      const dependency = i === 0 ? { branch: c.baseRef, head: c.base } : c.prefix[i - 1]!;
      assert(r && r.baseRef === dependency.branch && r.baseHead === dependency.head && r.autoMerge === false,
        "original member base or merge policy changed");
    }
    const top = s.local.branches[c.prefix.length];
    assert(top ? top.branch === c.branch && !top.unsafe && top.head === s.head.sha && s.local.current === c.branch :
      s.local.current === parent.branch && s.head.sha === parent.head, "local top or current branch changed");
    const extra = s.remote.members[c.prefix.length];
    assert(!extra || (extra.branch === c.branch && extra.open && !extra.merged), "unexpected remote top");
    assert(s.remote.candidates.length <= 1, "multiple PRs use the intended branch");
  }
  async function snapshot() { const s = await driver.observe(); scoped(s); return s; }
  function observedBranch(s: PublicationSnapshot) {
    assert(s.remote.members.length === c.prefix.length && !s.remote.heads[c.branch] && !s.remote.candidates.length, "branch step already has remote publication");
    if (s.local.branches.length === c.prefix.length) return false;
    assert(s.head.sha === parent.head && !s.dirty, "new branch changed before its creation was recorded");
    return true;
  }
  function observedCommit(s: PublicationSnapshot, request: z.infer<typeof commitSchema>) {
    assert(s.local.branches.length === c.prefix.length + 1, "fix branch missing");
    if (s.head.sha === parent.head) return false;
    assert(s.head.tree === request.tree && s.head.parents.length === 1 && s.head.parents[0] === parent.head &&
      s.head.message === request.message && !s.dirty, "commit tree, parent, message or worktree changed");
    return true;
  }
  function observedSubmit(s: PublicationSnapshot, head: string) {
    assert(s.local.branches.length === c.prefix.length + 1 && s.head.sha === head && !s.dirty, "submission checkout changed");
    const extra = s.remote.members[c.prefix.length];
    const candidate = s.remote.candidates[0];
    assert(!s.remote.heads[c.branch] || s.remote.heads[c.branch] === head, "published branch head changed");
    assert(!candidate || (candidate.head === head && candidate.open && !candidate.merged), "published PR head or state changed");
    assert(!candidate || (candidate.draft && !candidate.autoMerge && candidate.baseRef === parent.branch && candidate.baseHead === parent.head),
      "published PR base or publication policy changed");
    if (!extra) return undefined; // Includes a pushed branch or detached PR: partial, never resubmit blindly.
    assert(extra.head === head && candidate?.pr === extra.pr && s.remote.heads[c.branch] === head && extra.draft &&
      extra.baseRef === parent.branch && extra.baseHead === parent.head && extra.autoMerge === false,
      "published layer is not the intended draft PR at the intended head");
    return extra.pr;
  }
  async function act(step: PublicationStep, request: unknown, before: () => Promise<void>, action: () => Promise<void>) {
    if (!await claimOperation(path(step), request)) return;
    if (step === "submit" && hooks.executionOwner) await recordPublicationExecution(evidence, "submit", request, hooks.executionOwner);
    await hooks.afterClaim?.(step);
    await before();
    try { await action(); await hooks.afterAction?.(step); }
    catch { /* Retain the intent and reconcile any completed or partial effects. */ }
  }
  async function commitRequest() {
    const raw = await readOperationIntent(path("commit"));
    if (raw === undefined) return undefined;
    const request = commitSchema.parse(raw);
    assert(issueDigest(request.context) === issueDigest(c), "commit intent belongs to another context");
    return request;
  }
  return {
    async createBranch(): Promise<PublicationOutcome> {
      const prior = await matchingIntent(path("branch"), branchRequest);
      let s = await snapshot();
      if (!prior && !await matchingIntent(path("branch"), branchRequest)) {
        assert(s.local.branches.length === c.prefix.length && !s.dirty && !s.remote.heads[c.branch] &&
          !s.remote.candidates.length && s.remote.members.length === c.prefix.length, "branch already exists without its intent");
        await act("branch", branchRequest, async () => { const now = await snapshot();
          assert(now.local.branches.length === c.prefix.length && !now.dirty && !now.remote.heads[c.branch] &&
            !now.remote.candidates.length && now.remote.members.length === c.prefix.length, "branch precondition changed");
        }, () => driver.add(c.branch));
        s = await snapshot();
      }
      return { state: observedBranch(s) ? "verified" : "pending", step: "branch", snapshot: s };
    },
    async commit(admission: CommitAdmission, allowedPaths: string[], subject: string): Promise<PublicationOutcome> {
      admission = admissionSchema.parse(admission);
      assert(await matchingIntent(path("branch"), branchRequest), "branch has no operation intent");
      let request = await commitRequest(), s = await snapshot();
      request ??= await commitRequest();
      if (!request) {
        assert(s.local.branches.length === c.prefix.length + 1 && s.head.sha === parent.head && s.dirty &&
          !s.untracked.length && s.changed.length && s.changed.every(p => allowedPaths.includes(p)), "unexpected commit input");
        const paths = [...s.changed].sort();
        const tree = await driver.stage(paths);
        request = commitSchema.parse({ kind: "commit", context: c, tree, paths, admission,
          message: `${subject}\n\nKGR-Operation: ${issueDigest({ context: c, tree, admission })}` });
        const intended = request;
        await act("commit", request, async () => {
          const now = await snapshot();
          assert(now.head.sha === parent.head && now.local.current === c.branch && !now.untracked.length &&
            now.changed.every(p => paths.includes(p)) && await driver.stage(paths) === tree, "commit content changed after admission");
        }, () => driver.commit(intended.message));
        s = await snapshot();
      }
      assert(issueDigest(request.admission) === issueDigest(admission) && request.paths.every(p => allowedPaths.includes(p)) &&
        request.message.startsWith(subject + "\n\nKGR-Operation: "), "commit admission changed");
      const verified = observedCommit(s, request);
      return { state: verified ? "verified" : "pending", step: "commit", snapshot: s, ...(verified ? { head: s.head.sha } : {}) };
    },
    async submit(head: string): Promise<PublicationOutcome> {
      sha.parse(head);
      const request = { kind: "submit", context: c, head };
      const prior = await matchingIntent(path("submit"), request);
      const commit = await commitRequest(); assert(commit, "submission lacks an admitted commit");
      let s = await snapshot(); assert(observedCommit(s, commit!), "admitted commit missing");
      if (!prior && !await matchingIntent(path("submit"), request)) {
        assert(s.remote.members.length === c.prefix.length && !s.remote.heads[c.branch] && !s.remote.candidates.length,
          "remote publication exists without its submission intent");
        await act("submit", request, async () => { const now = await snapshot();
          assert(observedCommit(now, commit!) && now.head.sha === head && !now.dirty &&
            now.remote.members.length === c.prefix.length && !now.remote.heads[c.branch] && !now.remote.candidates.length, "submission precondition changed");
        }, () => driver.submit(head));
        s = await snapshot();
      }
      const pr = observedSubmit(s, head);
      return { state: pr ? "verified" : "pending", step: "submit", snapshot: s, head, ...(pr ? { pr } : {}) };
    },
    async reconcile(): Promise<{ branch?: PublicationOutcome; commit?: PublicationOutcome; submit?: PublicationOutcome }> {
      const result: { branch?: PublicationOutcome; commit?: PublicationOutcome; submit?: PublicationOutcome } = {};
      const b = await matchingIntent(path("branch"), branchRequest), commit = await commitRequest();
      const submit = await readOperationIntent(path("submit"));
      if (!b && !commit && !submit) return result;
      assert(b, "later publication intent lacks branch intent");
      const s = await snapshot();
      if (!commit) result.branch = { state: observedBranch(s) ? "verified" : "pending", step: "branch", snapshot: s };
      else {
        const done = observedCommit(s, commit);
        result.branch = { state: "verified", step: "branch", snapshot: s };
        result.commit = { state: done ? "verified" : "pending", step: "commit", snapshot: s, ...(done ? { head: s.head.sha } : {}) };
        if (submit) {
          assert(done, "submission intent has no matching commit");
          assert(await matchingIntent(path("submit"), { kind: "submit", context: c, head: s.head.sha }), "submission request mismatch");
          const pr = observedSubmit(s, s.head.sha);
          result.submit = { state: pr ? "verified" : "pending", step: "submit", snapshot: s, head: s.head.sha, ...(pr ? { pr } : {}) };
        }
      }
      return result;
    },
  };
}

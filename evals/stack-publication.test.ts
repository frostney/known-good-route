import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { stackPublisher, type PublicationSnapshot, type StackPublicationContext, type StackPublicationDriver, type PublicationStep } from "./stack-publication.ts";
import { publishStackSubmission, recoverStackSubmission } from "./stack-partial-recovery.ts";
import { publicationExecutionRequest } from "./publication-execution.ts";
import { claimOperation, readOperationIntent } from "./operation-intent.ts";
import { issueDigest } from "./issue-receipt.ts";
import { ownedProcessGroup } from "./process-group.ts";
import { command } from "./github-live.ts";

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
const admission = { revision: "revision-1", reviewAttempt: "native-1", gateDigest: "gate-1" }, allowed = ["src/store.mjs"];
const subject = "fix: preserve all JSON values";
async function fixture() {
  const evidence = await mkdtemp(join(tmpdir(), "kgr-stack-publish-")); dirs.push(evidence);
  const c: StackPublicationContext = { repository: "frostney/kgr-eval-20260906-tests", repositoryId: 42, directory: "/fixture", stack: 3, stackId: 99,
    baseRef: "main", base: "a".repeat(40), branch: "codex/eval-fix",
    prefix: [{ pr: 1, branch: "codex/eval-store", head: "b".repeat(40) }, { pr: 2, branch: "codex/eval-batch", head: "c".repeat(40) }] };
  const s: PublicationSnapshot = { repository: { id: 42, full_name: c.repository, private: true }, directory: c.directory, origin: `https://github.com/${c.repository}.git`,
    local: { trunk: "main", base: c.base, current: c.prefix[1]!.branch, branches: c.prefix.map(p => ({ branch: p.branch, head: p.head, unsafe: false })) },
    remote: { stack: c.stack, id: c.stackId, baseRef: "main", base: c.base, open: true,
      members: c.prefix.map((p, i) => ({ ...p, open: true, merged: false, draft: true, autoMerge: false,
        baseRef: i === 0 ? c.baseRef : c.prefix[i - 1]!.branch, baseHead: i === 0 ? c.base : c.prefix[i - 1]!.head })), heads: Object.fromEntries(c.prefix.map(p => [p.branch, p.head])), candidates: [] },
    head: { sha: c.prefix[1]!.head, tree: "d".repeat(40), parents: [c.prefix[0]!.head], message: "original" }, dirty: false, changed: [], untracked: [] };
  let tree = "e".repeat(40);
  const counts = { branch: 0, commit: 0, submit: 0 };
  const driver: StackPublicationDriver = {
    observe: async () => structuredClone(s),
    add: async branch => { counts.branch++; s.local.current = branch; s.local.branches.push({ branch, head: s.head.sha, unsafe: false }); },
    stage: async () => tree,
    commit: async message => { counts.commit++; s.head = { sha: "f".repeat(40), parents: [s.head.sha], tree, message };
      s.local.branches.at(-1)!.head = s.head.sha; s.dirty = false; s.changed = []; },
    submit: async () => { counts.submit++; s.remote.heads[c.branch] = s.head.sha;
      s.remote.candidates.push({ pr: 4, head: s.head.sha, open: true, merged: false, draft: true, baseRef: c.prefix.at(-1)!.branch, baseHead: c.prefix.at(-1)!.head, autoMerge: false });
      s.remote.members.push({ pr: 4, branch: c.branch, head: s.head.sha, open: true, merged: false, draft: true,
        baseRef: c.prefix.at(-1)!.branch, baseHead: c.prefix.at(-1)!.head, autoMerge: false }); },
  };
  const publisher = (hooks = {}) => stackPublisher(c, driver, evidence, hooks);
  const edit = () => { s.dirty = true; s.changed = [...allowed]; };
  const committed = async () => { await publisher().createBranch(); edit(); return publisher().commit(admission, allowed, subject); };
  return { c, s, counts, driver, evidence, publisher, edit, committed, changeTree: () => { tree = "9".repeat(40); } };
}
async function currentOwner() { return ownedProcessGroup(Number(await command(["ps", "-p", String(process.pid), "-o", "pgid="]))); }
async function deadOwner() {
  const child = Bun.spawn([process.execPath, "-e", "setInterval(()=>{},1000)"], { detached: true, stdout: "ignore", stderr: "ignore" });
  try {
    const owner = await ownedProcessGroup(child.pid);
    process.kill(-child.pid, "SIGKILL"); await child.exited; return owner;
  } finally {
    try { process.kill(-child.pid, "SIGKILL"); } catch (e: any) { if (e.code !== "ESRCH") throw e; }
    await child.exited;
  }
}
async function partialFixture(detached = false, ownerRecord = true) {
  const f = await fixture(); await f.committed(); let links = 0, creates = 0, linkedPr: number | undefined;
  f.driver.submit = async () => { f.counts.submit++; f.s.remote.heads[f.c.branch] = f.s.head.sha;
    if (detached) f.s.remote.candidates.push({ pr: 4, head: f.s.head.sha, open: true, merged: false, draft: true, baseRef: f.c.prefix.at(-1)!.branch, baseHead: f.c.prefix.at(-1)!.head, autoMerge: false });
    throw Error("controlled partial submission"); };
  await f.publisher().submit(f.s.head.sha);
  const request = await readOperationIntent(join(f.evidence, "submit-intent.json"));
  const executor = publicationExecutionRequest("submit", request, await deadOwner());
  if (ownerRecord) await claimOperation(join(f.evidence, "submit-executor.json"), executor);
  f.driver.createPR = async () => {
    creates++;
    f.s.remote.candidates.push({ pr: 4, head: f.s.head.sha, open: true, merged: false, draft: true, baseRef: f.c.prefix.at(-1)!.branch, baseHead: f.c.prefix.at(-1)!.head, autoMerge: false });
  };
  f.driver.link = async pr => {
    links++; linkedPr = pr;
    expect(pr).toBe(f.s.remote.candidates[0]?.pr);
    f.s.remote.members.push({ pr: 4, branch: f.c.branch, head: f.s.head.sha, open: true, merged: false, draft: true,
      baseRef: f.c.prefix.at(-1)!.branch, baseHead: f.c.prefix.at(-1)!.head, autoMerge: false });
  };
  return { ...f, request, executor, linkCount: () => links, createCount: () => creates, linkedPr: () => linkedPr,
    recover: async (hooks = {}) => recoverStackSubmission(f.c, f.driver, f.evidence, await currentOwner(), hooks) };
}
async function initialFixture() {
  const f = await fixture(); await f.committed(); let creates = 0, appends = 0;
  f.driver.submit = async () => { f.counts.submit++; f.s.remote.heads[f.c.branch] = f.s.head.sha; };
  f.driver.createPR = async () => { creates++; f.s.remote.candidates.push({ pr: 4, head: f.s.head.sha, open: true, merged: false,
    draft: true, baseRef: f.c.prefix.at(-1)!.branch, baseHead: f.c.prefix.at(-1)!.head, autoMerge: false }); };
  f.driver.link = async pr => { appends++; expect(pr).toBe(4);
    f.s.remote.members.push({ pr: 4, branch: f.c.branch, head: f.s.head.sha, open: true, merged: false, draft: true,
      baseRef: f.c.prefix.at(-1)!.branch, baseHead: f.c.prefix.at(-1)!.head, autoMerge: false }); };
  return { ...f, creates: () => creates, appends: () => appends,
    publish: async (hooks = {}) => publishStackSubmission(f.c, f.driver, f.evidence, await currentOwner(), f.s.head.sha, hooks) };
}
test("initial publication pushes, creates, and appends once in one owned invocation", async () => {
  const f = await initialFixture();
  expect((await f.publish()).pr).toBe(4); expect((await f.publish()).state).toBe("verified");
  expect(f.counts.submit).toBe(1); expect(f.creates()).toBe(1); expect(f.appends()).toBe(1);
  expect(await readOperationIntent(join(f.evidence, "submit-completion.json"))).toBeDefined();
});
test("competing initial callers cannot duplicate any publication phase", async () => {
  const f = await initialFixture(); await Promise.all([f.publish(), f.publish(), f.publish()]);
  expect((await f.publish()).state).toBe("verified");
  expect(f.counts.submit).toBe(1); expect(f.creates()).toBe(1); expect(f.appends()).toBe(1);
});
test("a lost push response cannot authorize same-worker creation or another push", async () => {
  const f = await initialFixture(), push = f.driver.submit;
  f.driver.submit = async head => { await push(head); throw Error("push response lost"); };
  expect((await f.publish()).state).toBe("pending"); expect((await f.publish()).state).toBe("pending");
  expect(f.counts.submit).toBe(1); expect(f.creates()).toBe(0); expect(f.appends()).toBe(0);
  expect(await readOperationIntent(join(f.evidence, "submit-completion.json"))).toBeUndefined();
});
test("unchanged prefix commits do not authorize publication with changed bases or auto-merge", async () => {
  for (const position of [0, 1]) for (const patch of [{ baseRef: "unapproved-base" }, { baseHead: "9".repeat(40) }, { autoMerge: true }]) {
    const f = await initialFixture(); Object.assign(f.s.remote.members[position]!, patch);
    await expect(f.publish()).rejects.toThrow("original member base or merge policy");
    expect(f.counts.submit).toBe(0); expect(f.creates()).toBe(0); expect(f.appends()).toBe(0);
  }
});
test("a changed prefix policy between creation and append invalidates continuation", async () => {
  const f = await initialFixture();
  await expect(f.publish({ afterCreate: async () => { f.s.remote.members[0]!.autoMerge = true; } })).rejects.toThrow("original member base or merge policy");
  expect(f.creates()).toBe(1); expect(f.appends()).toBe(0);
  expect(await readOperationIntent(join(f.evidence, "link-pr-intent.json"))).toBeUndefined();
});
test("new layer member metadata cannot disagree with its candidate PR observation", async () => {
  const f = await initialFixture(), append = f.driver.link!;
  f.driver.link = async (pr, head) => { await append(pr, head); f.s.remote.members.at(-1)!.baseRef = "unapproved-base"; };
  await expect(f.publish()).rejects.toThrow("intended draft PR");
  expect(f.appends()).toBe(1);
});
test("saved phase completions cannot impersonate a fresh caller's live execution", async () => {
  const f = await initialFixture();
  await expect(f.publish({ afterCreate: async () => { throw Error("interrupted creator"); } })).rejects.toThrow("interrupted creator");
  expect(await readOperationIntent(join(f.evidence, "submit-completion.json"))).toBeDefined();
  expect(await readOperationIntent(join(f.evidence, "create-pr-completion.json"))).toBeDefined();
  expect((await f.publish()).state).toBe("pending");
  expect(f.counts.submit).toBe(1); expect(f.creates()).toBe(1); expect(f.appends()).toBe(0);
});
test("stopped partial submissions finish through native linking without another submit", async () => {
  for (const detached of [false, true]) {
    const f = await partialFixture(detached);
    expect((await f.recover()).pr).toBe(4); expect((await f.recover()).state).toBe("verified");
    expect(f.counts.submit).toBe(1); expect(f.linkCount()).toBe(1); expect(f.linkedPr()).toBe(4); expect(f.createCount()).toBe(detached ? 0 : 1);
  }
});
test("legacy partial intents without execution ownership remain pending", async () => {
  const f = await partialFixture(false, false);
  expect((await f.recover()).reason).toContain("ownership is incomplete"); expect(f.linkCount()).toBe(0);
});
test("uncertain creation cannot advance or repeat while its executor remains live", async () => {
  const f = await partialFixture(), create = f.driver.createPR!;
  f.driver.createPR = async head => { await create(head); throw Error("response lost after creation"); };
  expect((await f.recover()).state).toBe("pending");
  expect((await f.recover()).state).toBe("pending");
  expect(f.createCount()).toBe(1); expect(f.linkCount()).toBe(0);
  expect(await readOperationIntent(join(f.evidence, "create-pr-completion.json"))).toBeUndefined();
});
test("a changed newly created PR base prevents claiming an append", async () => {
  const f = await partialFixture(), create = f.driver.createPR!;
  f.driver.createPR = async head => { await create(head); f.s.remote.candidates[0]!.baseRef = "main"; };
  await expect(f.recover()).rejects.toThrow("base or publication policy");
  expect(f.createCount()).toBe(1); expect(f.linkCount()).toBe(0);
  expect(await readOperationIntent(join(f.evidence, "link-pr-intent.json"))).toBeUndefined();
});
test("a stopped legacy branch link without a visible PR cannot authorize a new creation", async () => {
  const f = await partialFixture();
  const intent = { kind: "finish-submission", phase: "link-branch", context: f.c, head: f.s.head.sha, pr: null,
    originalRequestDigest: issueDigest(f.request), predecessorExecutions: [issueDigest(f.executor)] };
  await claimOperation(join(f.evidence, "link-branch-intent.json"), intent);
  await claimOperation(join(f.evidence, "link-branch-executor.json"), publicationExecutionRequest("link-branch", intent, await deadOwner()));
  expect((await f.recover()).reason).toContain("Legacy branch linking is uncertain");
  expect(f.createCount()).toBe(0); expect(f.linkCount()).toBe(0);
});
test("detached PR base and publication policy must match before claiming recovery", async () => {
  for (const patch of [{ draft: false }, { autoMerge: true }, { baseRef: "main" }, { baseHead: "9".repeat(40) }]) {
    const f = await partialFixture(true);
    Object.assign(f.s.remote.candidates[0]!, patch);
    await expect(f.recover()).rejects.toThrow("base or publication policy");
    expect(f.linkCount()).toBe(0);
    expect(await readOperationIntent(join(f.evidence, "link-pr-intent.json"))).toBeUndefined();
  }
});
test("changed detached PR policy after recovery claim prevents native linking", async () => {
  const f = await partialFixture(true);
  await expect(f.recover({ afterClaim: async () => { f.s.remote.candidates[0]!.draft = false; } })).rejects.toThrow("base or publication policy");
  expect(f.linkCount()).toBe(0);
  expect(await readOperationIntent(join(f.evidence, "link-pr-intent.json"))).toBeDefined();
});
test("a still-owned partial command cannot start another publication phase", async () => {
  const f = await partialFixture(false, false), owner = await currentOwner();
  await claimOperation(join(f.evidence, "submit-executor.json"), publicationExecutionRequest("submit", f.request, owner));
  expect((await f.recover()).state).toBe("pending"); expect(f.linkCount()).toBe(0);
});
test("competing partial recovery callers perform one remaining native action", async () => {
  const f = await partialFixture(); const outcomes = await Promise.all([f.recover(), f.recover(), f.recover()]);
  expect(outcomes.every(v => ["pending", "verified"].includes(v.state))).toBe(true);
  expect((await f.recover()).state).toBe("verified"); expect(f.linkCount()).toBe(1); expect(f.counts.submit).toBe(1);
});
test("partial recovery rejects changed leases, membership and commit input", async () => {
  for (const mutate of [
    (f: Awaited<ReturnType<typeof partialFixture>>) => { f.s.remote.base = "9".repeat(40); },
    (f: Awaited<ReturnType<typeof partialFixture>>) => { f.s.remote.heads[f.c.branch] = "9".repeat(40); },
    (f: Awaited<ReturnType<typeof partialFixture>>) => { f.s.remote.members.reverse(); },
    (f: Awaited<ReturnType<typeof partialFixture>>) => { f.s.dirty = true; },
  ]) {
    const f = await partialFixture(); mutate(f);
    await expect(f.recover()).rejects.toThrow("invalidated"); expect(f.linkCount()).toBe(0);
  }
});
test("a changed remote precondition after claiming a remaining phase prevents linking", async () => {
  const f = await partialFixture();
  await expect(f.recover({ afterClaim: async () => { f.s.remote.heads[f.c.branch] = "9".repeat(40); } })).rejects.toThrow("invalidated");
  expect(f.linkCount()).toBe(0);
});
test("a completed native link survives a lost response without duplication", async () => {
  const f = await partialFixture();
  expect((await f.recover({ afterLink: async () => { throw Error("lost response"); } })).pr).toBe(4);
  expect((await f.recover()).pr).toBe(4); expect(f.linkCount()).toBe(1);
});
test("a later visible detached PR advances the phase after both earlier groups stopped", async () => {
  const f = await partialFixture();
  const intent = { kind: "finish-submission", phase: "link-branch", context: f.c, head: f.s.head.sha, pr: null,
    originalRequestDigest: issueDigest(f.request), predecessorExecutions: [issueDigest(f.executor)] };
  await claimOperation(join(f.evidence, "link-branch-intent.json"), intent);
  await claimOperation(join(f.evidence, "link-branch-executor.json"), publicationExecutionRequest("link-branch", intent, await deadOwner()));
  f.s.remote.candidates.push({ pr: 4, head: f.s.head.sha, open: true, merged: false, draft: true, baseRef: f.c.prefix.at(-1)!.branch, baseHead: f.c.prefix.at(-1)!.head, autoMerge: false });
  expect((await f.recover()).pr).toBe(4); expect(f.linkedPr()).toBe(4); expect(f.linkCount()).toBe(1);
});
test("branch, commit and submission recover exact effects without repeating actions", async () => {
  const f = await fixture(); await f.committed();
  expect((await f.publisher().submit(f.s.head.sha)).state).toBe("verified");
  const recovered = await f.publisher().reconcile();
  expect(recovered.branch?.state).toBe("verified"); expect(recovered.commit?.head).toBe(f.s.head.sha); expect(recovered.submit?.pr).toBe(4);
  expect((await f.publisher().commit(admission, allowed, subject)).state).toBe("verified");
  expect((await f.publisher().submit(f.s.head.sha)).pr).toBe(4);
  expect(f.counts).toEqual({ branch: 1, commit: 1, submit: 1 });
});
test("lost command responses reconcile each completed step", async () => {
  const f = await fixture();
  const p = f.publisher({ afterAction: async () => { throw Error("coordinator lost response"); } });
  expect((await p.createBranch()).state).toBe("verified"); f.edit();
  expect((await p.commit(admission, allowed, subject)).state).toBe("verified");
  expect((await p.submit(f.s.head.sha)).state).toBe("verified");
  expect(f.counts).toEqual({ branch: 1, commit: 1, submit: 1 });
});
test("pre-action interruptions preserve pending intent without retrying mutations", async () => {
  for (const step of ["branch", "commit", "submit"] as const) {
    const f = await fixture();
    if (step !== "branch") { await f.publisher().createBranch(); f.edit(); }
    if (step === "submit") await f.publisher().commit(admission, allowed, subject);
    const interrupted = f.publisher({ afterClaim: async (v: PublicationStep) => { if (v === step) throw Error("interrupted"); } });
    const call = (p: ReturnType<typeof f.publisher>) => step === "branch" ? p.createBranch() : step === "commit" ? p.commit(admission, allowed, subject) : p.submit(f.s.head.sha);
    await expect(call(interrupted)).rejects.toThrow("interrupted");
    expect((await call(f.publisher())).state).toBe("pending");
    expect(f.counts[step]).toBe(0);
  }
});
test("concurrent submitters publish one native layer", async () => {
  const f = await fixture(); await f.committed();
  const results = await Promise.all(Array.from({ length: 8 }, () => f.publisher().submit(f.s.head.sha)));
  expect(results.every(v => ["verified", "pending"].includes(v.state))).toBe(true); expect(f.counts.submit).toBe(1);
  expect((await f.publisher().reconcile()).submit?.state).toBe("verified");
});
test("a competing caller reports pending while the owning submitter is still running", async () => {
  const f = await fixture(); await f.committed();
  let started!: () => void, finish!: () => void;
  const waiting = new Promise<void>(resolve => { started = resolve; });
  const released = new Promise<void>(resolve => { finish = resolve; });
  const submit = f.driver.submit;
  f.driver.submit = async head => { started(); await released; await submit(head); };
  const owner = f.publisher().submit(f.s.head.sha);
  await waiting;
  expect((await f.publisher().submit(f.s.head.sha)).state).toBe("pending");
  finish(); expect((await owner).state).toBe("verified"); expect(f.counts.submit).toBe(1);
});
test("concurrent branch creators cannot add two local layers", async () => {
  const f = await fixture();
  await Promise.all(Array.from({ length: 8 }, () => f.publisher().createBranch()));
  expect(f.counts.branch).toBe(1); expect(f.s.local.branches.length).toBe(3);
});
test("partial branch push or detached PR stays pending without resubmission", async () => {
  for (const detachedPr of [false, true]) {
    const f = await fixture(); await f.committed();
    f.driver.submit = async () => { f.counts.submit++; f.s.remote.heads[f.c.branch] = f.s.head.sha;
      if (detachedPr) f.s.remote.candidates.push({ pr: 4, head: f.s.head.sha, open: true, merged: false, draft: true, baseRef: f.c.prefix.at(-1)!.branch, baseHead: f.c.prefix.at(-1)!.head, autoMerge: false });
      throw Error("submit stopped halfway"); };
    expect((await f.publisher().submit(f.s.head.sha)).state).toBe("pending");
    expect((await f.publisher().submit(f.s.head.sha)).state).toBe("pending");
    expect((await f.publisher().reconcile()).submit?.state).toBe("pending"); expect(f.counts.submit).toBe(1);
  }
});
test("changed original heads, leases, base, identity or topology invalidate recovery", async () => {
  const changes: ((f: Awaited<ReturnType<typeof fixture>>) => void)[] = [
    f => { f.s.repository.id++; }, f => { f.s.origin = "https://github.com/other/repo.git"; },
    f => { f.s.remote.base = "9".repeat(40); }, f => { f.s.local.base = "9".repeat(40); },
    f => { f.s.remote.id++; }, f => { f.s.remote.open = false; },
    f => { f.s.remote.members[0]!.head = "9".repeat(40); }, f => { f.s.remote.heads[f.c.prefix[0]!.branch] = "9".repeat(40); },
    f => { f.s.local.branches[0]!.unsafe = true; }, f => { f.s.remote.members.reverse(); },
    f => { f.s.local.branches.push({ branch: "codex/eval-unrelated", head: f.s.head.sha, unsafe: false }); },
  ];
  for (const change of changes) { const f = await fixture(); await f.committed(); change(f);
    await expect(f.publisher().reconcile()).rejects.toThrow("invalidated"); expect(f.counts.submit).toBe(0); }
});
test("unrelated work and staged files cannot enter the admitted commit", async () => {
  for (const untracked of [false, true]) {
    const f = await fixture(); await f.publisher().createBranch(); f.edit();
    if (untracked) f.s.untracked.push("secret.txt"); else f.s.changed.push("tests/test.mjs");
    await expect(f.publisher().commit(admission, allowed, subject)).rejects.toThrow("unexpected commit input");
    expect(f.counts.commit).toBe(0);
  }
});
test("changed content between admission and commit prevents mutation", async () => {
  const f = await fixture(); await f.publisher().createBranch(); f.edit();
  const p = f.publisher({ afterClaim: async (step: PublicationStep) => { if (step === "commit") f.changeTree(); } });
  await expect(p.commit(admission, allowed, subject)).rejects.toThrow("content changed"); expect(f.counts.commit).toBe(0);
  expect((await f.publisher().commit(admission, allowed, subject)).state).toBe("pending");
});
test("recovery rejects different commit tree, parent, message or dirty worktree", async () => {
  for (const change of [
    (s: PublicationSnapshot) => { s.head.tree = "9".repeat(40); },
    (s: PublicationSnapshot) => { s.head.parents = ["9".repeat(40)]; },
    (s: PublicationSnapshot) => { s.head.parents.push("9".repeat(40)); },
    (s: PublicationSnapshot) => { s.head.message = "another commit"; },
    (s: PublicationSnapshot) => { s.dirty = true; },
  ]) { const f = await fixture(); await f.committed(); change(f.s);
    await expect(f.publisher().reconcile()).rejects.toThrow("commit tree"); }
});
test("a new admission cannot reuse an existing commit intent", async () => {
  const f = await fixture(); await f.committed();
  for (const patch of [{ revision: "other" }, { reviewAttempt: "other" }, { gateDigest: "other" }])
    await expect(f.publisher().commit({ ...admission, ...patch }, allowed, subject)).rejects.toThrow("admission changed");
  expect(f.counts.commit).toBe(1);
});
test("unrecorded remote artifacts are never adopted as this run's submission", async () => {
  const f = await fixture(); await f.committed(); await f.driver.submit(f.s.head.sha);
  await expect(f.publisher().submit(f.s.head.sha)).rejects.toThrow("without its submission intent");
  expect(f.counts.submit).toBe(1);
});
test("moved, ready, merged, duplicate or unbound published PRs invalidate recovery", async () => {
  for (const change of [
    (s: PublicationSnapshot) => { s.remote.members.at(-1)!.head = "9".repeat(40); },
    (s: PublicationSnapshot) => { s.remote.members.at(-1)!.draft = false; },
    (s: PublicationSnapshot) => { s.remote.members.at(-1)!.merged = true; },
    (s: PublicationSnapshot) => { s.remote.candidates.push({ ...s.remote.candidates[0]!, pr: 5 }); },
    (s: PublicationSnapshot) => { s.remote.candidates = []; },
  ]) { const f = await fixture(); await f.committed(); await f.publisher().submit(f.s.head.sha); change(f.s);
    await expect(f.publisher().reconcile()).rejects.toThrow("invalidated"); expect(f.counts.submit).toBe(1); }
});

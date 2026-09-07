import { chmod, mkdir, readdir, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { command, digest } from "./github-live.ts";
import { atomicJson } from "./issue-receipt.ts";
import { claimOperation, readOperationIntent } from "./operation-intent.ts";
import { freezeSnapshot } from "./snapshot.ts";
import { ownedProcessGroup, requireGroupStopped } from "./process-group.ts";
import { observeProcess } from "./process-identity.ts";
import { nativeStackPublicationDriver } from "./stack-publication-driver.ts";
import { stackPublisher, type StackPublicationContext } from "./stack-publication.ts";

if (process.env.CI || process.env.GITHUB_ACTIONS || !Bun.argv.includes("--execute")) throw Error("Race trial requires explicit local --execute");
const arg = (name: string) => { const i = Bun.argv.indexOf(name); return i < 0 ? undefined : Bun.argv[i + 1]; };
const check = (ok: unknown, message: string) => { if (!ok) throw Error(message); };
const worker = arg("--worker"), controller = arg("--controller");
if (worker) {
  const root = resolve(worker), c = await Bun.file(join(root, "config.json")).json();
  const deadline = Date.now() + 5000;
  while (!await Bun.file(join(root, "worker-group.json")).exists()) { if (Date.now() > deadline) throw Error("No owned worker"); await Bun.sleep(20); }
  const owner = await Bun.file(join(root, "worker-group.json")).json();
  check(JSON.stringify(owner) === JSON.stringify(await ownedProcessGroup(process.pid)), "Worker identity differs");
  const publisher = stackPublisher(c.context, nativeStackPublicationDriver(c.context, undefined, { legacySubmit: !c.nativePush }), c.intents, { executionOwner: owner });
  try {
    const outcome = await publisher.submit(c.head);
    await atomicJson(join(root, "worker-outcome.json"), { outcome });
  } catch (error) { await atomicJson(join(root, "worker-outcome.json"), { error: String(error) }); }
  process.exit(0);
}
if (!controller) {
  check(arg("--fixture") && arg("--output"), "Provide a fresh fixture and output");
  const root = resolve(arg("--output")!), f = await Bun.file(resolve(arg("--fixture")!)).json(); await mkdir(root);
  check(f.repository === "frostney/kgr-eval-20260906-push-races" && f.localHeads.length === 2, "Use the dedicated mutable race fixture");
  const context: StackPublicationContext = { repository: f.repository, repositoryId: f.repositoryId, directory: await realpath(f.directory),
    stack: f.stackNumber, stackId: f.stack.id, baseRef: f.defaultBranch, base: f.base, branch: `codex/eval-race-${crypto.randomUUID().slice(0, 8)}`,
    prefix: f.stack.pull_requests.map((p: any, i: number) => ({ pr: p.number, branch: f.branches[i], head: f.localHeads[i] })) };
  const before = await nativeStackPublicationDriver(context).observe();
  check(!before.dirty && before.head.sha === context.prefix.at(-1)!.head && before.remote.members.length === 2 &&
    before.repository.id === context.repositoryId && before.repository.private, "Fixture is not fresh and private");
  const snapshot = join(root, "snapshot"); await freezeSnapshot(snapshot);
  const nativePush = Bun.argv.includes("--native-push");
  const ownerPath = join(await command(["git", "rev-parse", "--absolute-git-dir"], context.directory), "kgr-push-race-owner.json");
  check(!await readOperationIntent(ownerPath), "Race fixture is already owned");
  check(await claimOperation(ownerPath, { context, evidence: root, snapshotDigest: digest(await Bun.file(join(snapshot, "manifest.json")).text()) }), "Fixture claim failed");
  await atomicJson(join(root, "plan.json"), { fixture: resolve(arg("--fixture")!), context, before, nativePush,
    purpose: "Pause the selected native stack publication command before its tracking fetch, advance only the first original fixture branch by one fast-forward commit, then require the admitted-head hook to reject the refreshed-lease push.",
    scope: "Dedicated private race fixture. Intentionally change first member head; preserve main and second member. No force push, PR creation by the trial, readiness or merge.", at: new Date().toISOString() });
  await atomicJson(join(root, "config.json"), { context, snapshot, evidence: root, intents: join(root, "intents"), realGit: await realpath(Bun.which("git")!), nativePush });
  const child = Bun.spawn([process.execPath, join(snapshot, "evals/stack-push-race-live-run.ts"), "--execute", "--controller", root], { stdout: "inherit", stderr: "inherit", stdin: "ignore" });
  process.exit(await child.exited);
}
const root = resolve(controller!), c = await Bun.file(join(root, "config.json")).json();
const git = (...args: string[]) => command([c.realGit, ...args], c.context.directory);
const publisher = stackPublisher(c.context, nativeStackPublicationDriver(c.context), c.intents);
check((await publisher.createBranch()).state === "verified", "Owned local layer missing");
const readme = join(c.context.directory, "README.md");
await Bun.write(readme, (await Bun.file(readme).text()).trimEnd() + "\n\nThis unsubmitted layer tests a concurrent branch update at publication.\n");
const commit = await publisher.commit({ revision: digest(await Bun.file(readme).text()), reviewAttempt: "transport-only", gateDigest: "no-source-change" }, ["README.md"], "test: reject stale native publication");
check(commit.state === "verified", "Local transport commit missing"); c.head = commit.head; await atomicJson(join(root, "config.json"), c);
await mkdir(join(root, "bin"));
const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
await Bun.write(join(root, "bin/git"), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(join(c.snapshot, "evals/stack-push-race-git.ts"))} ${quote(join(root, "config.json"))} "$@"\n`);
await chmod(join(root, "bin/git"), 0o755);
// A separate clone represents the concurrent writer and does not alter the
// publishing checkout's admitted local refs or index.
const competitor = join(root, "competitor");
await command([c.realGit, "clone", `https://github.com/${c.context.repository}.git`, competitor]);
const otherGit = (...args: string[]) => command([c.realGit, ...args], competitor);
const member = c.context.prefix[0];
const tree = await otherGit("rev-parse", `${member.head}^{tree}`);
const changed = await command([c.realGit, "commit-tree", tree, "-p", member.head, "-m", "test: concurrent fixture update"], competitor);
await atomicJson(join(root, "planned-transition.json"), { branch: member.branch, before: member.head, after: changed, fastForward: true });
const child = Bun.spawn([process.execPath, join(c.snapshot, "evals/stack-push-race-live-run.ts"), "--execute", "--worker", root],
  { detached: true, env: { ...process.env, PATH: `${join(root, "bin")}:${process.env.PATH}` },
    stdout: Bun.file(join(root, "worker-stdout.log")), stderr: Bun.file(join(root, "worker-stderr.log")), stdin: "ignore" });
const owner = await ownedProcessGroup(child.pid); await atomicJson(join(root, "worker-group.json"), owner);
try {
const deadline = Date.now() + 120000;
while (!await Bun.file(join(root, "before-fetch.json")).exists() && child.exitCode === null && Date.now() < deadline) await Bun.sleep(100);
if (!await Bun.file(join(root, "before-fetch.json")).exists()) {
  if (child.exitCode === null) { process.kill(-owner.group, "SIGKILL"); await child.exited; }
  await atomicJson(join(root, "worker-process.json"), { owner, exitCode: await child.exited, signal: child.signalCode, boundaryReached: false });
  throw Error("Required native fetch boundary was not observed; preserve diagnostic");
}
check((await Bun.file(join(root, "before-fetch.json")).json()).beforeTracking === member.head, "Tracking ref changed before controlled race");
check(await otherGit("ls-remote", "--heads", "origin", `refs/heads/${member.branch}`) === `${member.head}\trefs/heads/${member.branch}`, "Another writer already changed the fixture");
await otherGit("push", "origin", `${changed}:refs/heads/${member.branch}`);
await atomicJson(join(root, "accepted-transition.json"), { branch: member.branch, before: member.head, after: changed, at: new Date().toISOString() });
await atomicJson(join(root, "release-fetch.json"), { after: changed });
const stopped = { owner, exitCode: await child.exited, signal: child.signalCode, boundaryReached: true };
await atomicJson(join(root, "worker-process.json"), stopped); await requireGroupStopped(owner);
const current = await nativeStackPublicationDriver(c.context).observe();
const guards = join(await git("rev-parse", "--absolute-git-dir"), "kgr-push-guards"), guardRecords = [];
for (const name of await readdir(guards)) {
  const directory = join(guards, name), admission = await readOperationIntent(join(directory, "admission.json"));
  for (const file of (await readdir(directory)).filter(n => n.startsWith("check-")))
    guardRecords.push({ directory, admission, check: await Bun.file(join(directory, file)).json() });
}
const outcome = await Bun.file(join(root, "worker-outcome.json")).json();
const checks = { boundary: stopped.boundaryReached && stopped.exitCode === 0,
  refreshedLease: await git("rev-parse", `refs/remotes/origin/${member.branch}`) === changed,
  rejectedAtPush: guardRecords.some(r => !r.check.accepted && r.check.error.includes("advertised remote head differs")),
  preservedConcurrentUpdate: current.remote.heads[member.branch] === changed,
  preservedOthers: current.remote.base === c.context.base && current.remote.heads[c.context.prefix[1].branch] === c.context.prefix[1].head,
  noPublication: !current.remote.heads[c.context.branch] && current.remote.candidates.length === 0 && current.remote.members.length === 2,
  staleAdmissionRejected: outcome.error?.includes("original member or lease changed") === true };
const result = { passed: Object.values(checks).every(Boolean), checks, transition: { branch: member.branch, before: member.head, after: changed }, current, guardRecords, outcome, stopped,
  scope: "Actual native CLI refreshed its tracking lease after an authorized concurrent fast-forward fixture update; the pre-push admission guard rejected rollback. Other races and remote transaction atomicity are not established." };
await atomicJson(join(root, "result.json"), result); console.log(JSON.stringify({ passed: result.passed, checks, stack: c.context.stack, transition: result.transition }));
if (!result.passed) process.exitCode = 1;
} catch (error) {
  const leader = await observeProcess(owner.leader.pid);
  if (leader && !leader.terminal && leader.birth === owner.leader.birth) process.kill(-owner.group, "SIGKILL");
  await child.exited;
  await requireGroupStopped(owner);
  await atomicJson(join(root, "controller-failure.json"), { error: String(error), owner, exitCode: child.exitCode, signal: child.signalCode });
  throw error;
}

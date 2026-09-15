import { appendFile, chmod, mkdir, readdir, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { atomicJson } from "./issue-receipt.ts";
import { command, digest } from "./github-live.ts";
import { freezeSnapshot } from "./snapshot.ts";
import { ownedProcessGroup, requireGroupStopped } from "./process-group.ts";
import { claimOperation, readOperationIntent } from "./operation-intent.ts";
import { stackPublisher, type StackPublicationContext } from "./stack-publication.ts";
import { nativeStackPublicationDriver } from "./stack-publication-driver.ts";
import { publishStackSubmission, recoverStackSubmission } from "./stack-partial-recovery.ts";
import { runPipeline } from "./stack-program.ts";
import { runGuardedStack, stackPushAdmission } from "./stack-push-guard.ts";

if (process.env.CI || process.env.GITHUB_ACTIONS || !Bun.argv.includes("--execute")) throw Error("Partial publication requires explicit local --execute");
const arg = (name: string) => { const i = Bun.argv.indexOf(name); return i < 0 ? undefined : Bun.argv[i + 1]; };
const worker = arg("--worker"), controller = arg("--controller");
const check = (ok: unknown, message: string) => { if (!ok) throw Error(message); };
async function pauseRecovery(root: string, owner: unknown, phase: string) {
  await atomicJson(join(root, "recovery-paused.json"), { owner, phase });
  const deadline = Date.now() + 120000;
  while (!await Bun.file(join(root, "release-recovery.json")).exists()) {
    if (Date.now() >= deadline) throw Error("Controlled recovery boundary was not released");
    await Bun.sleep(50);
  }
}
const track = (config: any, output: string) => {
  const driver = nativeStackPublicationDriver(config.context, undefined, { legacySubmit: !config.initialPublication });
  for (const method of ["submit", "createPR", "link"] as const) {
    const original = driver[method]!.bind(driver) as (...args: any[]) => Promise<void>;
    (driver as any)[method] = async (...args: any[]) => {
      await appendFile(join(output, "actions.jsonl"), JSON.stringify({ method, pr: method === "link" ? args[0] ?? null : null, pid: process.pid, at: new Date().toISOString() }) + "\n");
      if (method === "link" && config.appendAfterObservation)
        await pauseRecovery(output, await Bun.file(join(output, "recover-group.json")).json(), "after-final-observation-before-append-request");
      try { await original(...args); }
      catch (error) { await atomicJson(join(output, `${method}-error.json`), { error: String(error) }); throw error; }
    };
  }
  return driver;
};
if (worker) {
  const root = resolve(worker), phase = arg("--phase")!;
  check(["submit", "publish", "recover", "finish", "create-pr"].includes(phase), "Unknown partial worker phase");
  const config = await Bun.file(join(root, "config.json")).json();
  const ownerPath = join(root, `${phase}-group.json`), deadline = Date.now() + 5000;
  while (!await Bun.file(ownerPath).exists()) { if (Date.now() >= deadline) throw Error("Worker ownership missing"); await Bun.sleep(20); }
  const owner = await Bun.file(ownerPath).json();
  check(JSON.stringify(owner) === JSON.stringify(await ownedProcessGroup(process.pid)), "Worker group identity differs");
  if (phase === "create-pr") {
    check(config.detachedPr, "Detached PR creation is outside this trial");
    await requireGroupStopped(await Bun.file(join(root, "submit-group.json")).json());
    const observed = (await stackPublisher(config.context, nativeStackPublicationDriver(config.context), config.intents).reconcile()).submit!;
    check(observed.state === "pending" && observed.snapshot.remote.heads[config.context.branch] === config.head &&
      observed.snapshot.remote.candidates.length === 0 && observed.snapshot.remote.members.length === 2, "Detached fixture precondition changed");
    check(await claimOperation(join(root, "detached-create-intent.json"), { context: config.context, head: config.head, owner }), "A creator already owns this PR operation");
    const body = join(root, "detached-pr-body.md");
    await Bun.write(body, "This draft is a controlled detached-PR recovery fixture created after native submit was stopped at its accepted branch push. It changes only README, retains seeded defects, and makes no readiness claim.\n");
    await appendFile(join(root, "actions.jsonl"), JSON.stringify({ method: "create-pr", pr: null, pid: process.pid, at: new Date().toISOString() }) + "\n");
    const url = await command(["gh", "pr", "create", "--draft", "--head", config.context.branch, "--base", config.context.prefix.at(-1).branch,
      "--title", "test: detached publication recovery fixture", "--body-file", body], config.context.directory);
    const parsed = new URL(url), pr = Number(parsed.pathname.split("/").at(-1));
    check(parsed.origin === "https://github.com" && parsed.pathname === `/${config.context.repository}/pull/${pr}` && Number.isSafeInteger(pr) && pr > 0, "Unexpected detached PR URL");
    await atomicJson(join(root, "detached-accepted.json"), { pr, url, head: config.head, owner, boundary: "after-gh-pr-create-before-phase-completion" });
    process.kill(-owner.group, "SIGKILL"); await new Promise(() => {});
  }
  if (phase === "submit") {
    await command(["git", "--version"], config.context.directory);
    check(await Bun.file(join(root, "interception-probe.json")).exists(), "Git interception is not active; submission was not started");
  }
  const driver = track(config, root);
  const hooks = {
    ...(config.competingAppend && !config.appendAfterObservation
      ? { afterClaim: () => pauseRecovery(root, owner, "after-link-pr-claim-before-final-observation") } : {}),
    ...(config.interruptCreate && ["recover", "publish"].includes(phase) ? { afterCreate: async () => {
      await atomicJson(join(root, "creation-boundary.json"), { owner, phase: "created-pr-before-append",
        observed: (await stackPublisher(config.context, driver, config.intents).reconcile()).submit });
      process.kill(-owner.group, "SIGKILL"); await new Promise(() => {});
    } } : {}),
  };
  let outcome;
  try {
    outcome = phase === "submit"
      ? await stackPublisher(config.context, driver, config.intents, { executionOwner: owner }).submit(config.head)
      : phase === "publish" ? await publishStackSubmission(config.context, driver, config.intents, owner, config.head, hooks)
      : await recoverStackSubmission(config.context, driver, config.intents, owner, hooks);
  } catch (error) {
    await atomicJson(join(root, `${phase}-error.json`), { error: String(error) }); process.exit(2);
  }
  await atomicJson(join(root, `${phase}-outcome.json`), outcome);
  console.log(JSON.stringify({ phase, state: outcome.state, pr: outcome.pr }));
  process.exit(outcome.state === "verified" ? 0 : 1);
}
if (!controller) {
  check(arg("--output") && arg("--fixture"), "Supply a fresh output and prepared fixture");
  const root = resolve(arg("--output")!); await mkdir(root);
  const fixture = await Bun.file(resolve(arg("--fixture")!)).json();
  check(/^frostney\/kgr-eval-\d{8}-[a-z0-9-]+$/.test(fixture.repository) && Number.isSafeInteger(fixture.repositoryId) && fixture.repositoryId > 0 &&
    fixture.localHeads.length === 2, "Unexpected disposable fixture");
  const context: StackPublicationContext = { repository: fixture.repository, repositoryId: fixture.repositoryId,
    directory: await realpath(fixture.directory), stack: fixture.stackNumber, stackId: fixture.stack.id,
    baseRef: fixture.defaultBranch, base: fixture.base, branch: `codex/eval-partial-${crypto.randomUUID().slice(0, 8)}`,
    prefix: fixture.stack.pull_requests.map((p: any, i: number) => ({ pr: p.number, branch: fixture.branches[i], head: fixture.localHeads[i] })) };
  const before = await nativeStackPublicationDriver(context).observe();
  check(!before.dirty && before.head.sha === context.prefix.at(-1)!.head && before.remote.members.length === 2 &&
    before.repository.id === context.repositoryId && before.repository.full_name === context.repository && before.repository.private, "Fixture is not fresh and private");
  const snapshot = join(root, "snapshot"); await freezeSnapshot(snapshot);
  const detachedPr = Bun.argv.includes("--detached-pr"), competingAppend = Bun.argv.includes("--competing-append");
  const appendAfterObservation = Bun.argv.includes("--append-after-observation");
  const interruptCreate = Bun.argv.includes("--interrupt-create");
  const initialPublication = Bun.argv.includes("--initial-publication");
  check(!competingAppend || detachedPr, "A competing append requires the detached PR scenario");
  check(!appendAfterObservation || competingAppend, "A late append requires the competing append scenario");
  check(!interruptCreate || !detachedPr, "Creation interruption requires branch-only recovery without a separately seeded PR");
  check(!initialPublication || !detachedPr, "Initial publication starts without a detached fixture");
  const ownerPath = join(await command(["git", "rev-parse", "--absolute-git-dir"], context.directory), "kgr-stack-partial-owner.json");
  check(!await readOperationIntent(ownerPath), "This fixture already belongs to a partial-publication trial");
  check(await claimOperation(ownerPath, { context, evidence: root, snapshotDigest: digest(await Bun.file(join(snapshot, "manifest.json")).text()) }), "Another trial owns this fixture");
  await atomicJson(join(root, "plan.json"), { fixture: resolve(arg("--fixture")!), context, snapshot, before, detachedPr, competingAppend, appendAfterObservation, interruptCreate, initialPublication,
    purpose: "Interrupt official gh stack submit after its git child pushes the new branch but before that child returns; recover with fixed-base PR creation and a separate native API append.",
    scope: "README-only draft transport. Optional detached fixture creates a real PR after the native branch-only interruption, then kills its creator before phase completion. Optional competing append adds another draft layer before final observation or, with appendAfterObservation, before the subsequent API write. No readiness, review, merge, original-head or base changes.", createdAt: new Date().toISOString() });
  await atomicJson(join(root, "config.json"), { context, snapshot, intents: join(root, "intents"), nodeBinary: fixture.nodeBinary,
    realGit: await realpath(Bun.which("git")!), boundaryPath: join(root, "partial-boundary.json"), detachedPr, competingAppend, appendAfterObservation, interruptCreate, initialPublication });
  const child = Bun.spawn([process.execPath, join(snapshot, "evals/stack-partial-live-run.ts"), "--execute", "--controller", root],
    { stdout: "inherit", stderr: "inherit", stdin: "ignore" });
  const exitCode = await child.exited;
  await atomicJson(join(root, "controller-process.json"), { pid: child.pid, exitCode, signal: child.signalCode });
  process.exit(exitCode);
}
const root = resolve(controller!), config = await Bun.file(join(root, "config.json")).json();
const driver = nativeStackPublicationDriver(config.context), publisher = stackPublisher(config.context, driver, config.intents);
check((await publisher.createBranch()).state === "verified", "Could not create the owned transport layer");
const readme = join(config.context.directory, "README.md");
await Bun.write(readme, (await Bun.file(readme).text()).trimEnd() + "\n\n## Partial publication fixture\n\nThis draft layer tests native publication interruption and recovery. Seeded defects remain.\n");
const visible = await runPipeline(config.context.directory, {}, config.nodeBinary, true);
await atomicJson(join(root, "visible-tests.json"), visible); check(visible.passed, "Visible transport fixture tests failed");
config.admission = { revision: digest(await Bun.file(readme).text()), reviewAttempt: "transport-only-no-native-review", gateDigest: digest(JSON.stringify(visible)) };
const commit = await publisher.commit(config.admission, ["README.md"], "test: exercise partial native publication");
check(commit.state === "verified", "Transport commit is incomplete"); config.head = commit.head;
await atomicJson(join(root, "config.json"), config);
await mkdir(join(root, "bin"));
const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
const shim = join(root, "bin/git");
await Bun.write(shim, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(join(config.snapshot, "evals/stack-partial-git.ts"))} ${quote(join(root, "config.json"))} "$@"\n`);
await chmod(shim, 0o755);
const workers: { child: Bun.Subprocess; owner: Awaited<ReturnType<typeof ownedProcessGroup>>; terminal: boolean }[] = [];
async function spawn(phase: string) {
  const child = Bun.spawn([process.execPath, join(config.snapshot, "evals/stack-partial-live-run.ts"), "--execute", "--worker", root, "--phase", phase],
    { detached: true, env: { ...process.env, PATH: phase === "submit" ? `${join(root, "bin")}:${process.env.PATH}` : process.env.PATH! },
      stdout: Bun.file(join(root, `${phase}-stdout.log`)), stderr: Bun.file(join(root, `${phase}-stderr.log`)), stdin: "ignore" });
  const owner = await ownedProcessGroup(child.pid);
  const tracked = { child, owner, terminal: false };
  workers.push(tracked);
  void child.exited.then(() => { tracked.terminal = true; });
  await atomicJson(join(root, `${phase}-group.json`), owner);
  return { child, owner };
}
try {
if (config.initialPublication) {
  const initial = await spawn("publish");
  const published = { owner: initial.owner, exitCode: await initial.child.exited, signal: initial.child.signalCode };
  await atomicJson(join(root, "publish-process.json"), published); await requireGroupStopped(initial.owner);
  let resumed = published, creationBoundary = null;
  if (config.interruptCreate) {
    creationBoundary = await Bun.file(join(root, "creation-boundary.json")).json();
    check(published.exitCode === 137 && published.signal === "SIGKILL" && creationBoundary.phase === "created-pr-before-append" &&
      creationBoundary.observed.state === "pending" && creationBoundary.observed.snapshot.remote.candidates.length === 1 &&
      creationBoundary.observed.snapshot.remote.members.length === config.context.prefix.length, "Initial creator interruption missing");
    const finish = await spawn("finish");
    resumed = { owner: finish.owner, exitCode: await finish.child.exited, signal: finish.child.signalCode };
    await atomicJson(join(root, "finish-process.json"), resumed); await requireGroupStopped(finish.owner);
  }
  const final = (await publisher.reconcile()).submit!, again = (await publisher.reconcile()).submit!;
  const actions = (await Bun.file(join(root, "actions.jsonl")).text()).trim().split("\n").map(v => JSON.parse(v));
  const checks = { published: resumed.exitCode === 0 && final.state === "verified", stable: again.pr === final.pr && again.head === final.head,
    onePush: actions.filter(v => v.method === "submit").length === 1, oneCreation: actions.filter(v => v.method === "createPR").length === 1,
    oneAppend: actions.filter(v => v.method === "link" && v.pr === final.pr).length === 1 && actions.length === 3,
    resumedCreation: !config.interruptCreate || (creationBoundary !== null && published.owner.group !== resumed.owner.group),
    oneCommit: await command(["git", "rev-list", "--count", `${config.context.prefix.at(-1).head}..HEAD`], config.context.directory) === "1" };
  const result = { passed: Object.values(checks).every(Boolean), checks, published, resumed, creationBoundary, final, actions,
    scope: "Initial publication uses guarded native push, fixed-base PR creation, then native append. Optional SIGKILL interrupts this actual initial creator before append; a new worker finishes without repeating earlier effects." };
  await atomicJson(join(root, "result.json"), result); console.log(JSON.stringify({ passed: result.passed, checks, stack: config.context.stack, pr: final.pr, head: final.head }));
  if (!result.passed) process.exitCode = 1;
} else {
const first = await spawn("submit"), deadline = Date.now() + 120000;
while (!await Bun.file(config.boundaryPath).exists() && first.child.exitCode === null && Date.now() < deadline) await Bun.sleep(100);
const boundaryReached = await Bun.file(config.boundaryPath).exists();
if (first.child.exitCode === null) {
  check(JSON.stringify(await ownedProcessGroup(first.child.pid)) === JSON.stringify(first.owner), "Submission ownership changed before interruption");
  process.kill(-first.owner.group, "SIGKILL");
}
const stopped = { owner: first.owner, exitCode: await first.child.exited, signal: first.child.signalCode, boundaryReached };
await atomicJson(join(root, "submit-process.json"), stopped); await requireGroupStopped(first.owner);
check(boundaryReached && stopped.exitCode === 137 && stopped.signal === "SIGKILL", "Requested in-command boundary was not observed; preserve this diagnostic");
const partial = (await publisher.reconcile()).submit!;
await atomicJson(join(root, "partial-observation.json"), partial);
check(partial.state === "pending" && partial.snapshot.remote.heads[config.context.branch] === config.head &&
  partial.snapshot.remote.members.length === 2 && partial.snapshot.remote.candidates.length === 0, "The interrupted state is not pushed-branch-only");
let detached = null, creator = null;
if (config.detachedPr) {
  const creation = await spawn("create-pr");
  creator = { owner: creation.owner, exitCode: await creation.child.exited, signal: creation.child.signalCode };
  await atomicJson(join(root, "create-pr-process.json"), creator); await requireGroupStopped(creation.owner);
  check(creator.exitCode === 137 && creator.signal === "SIGKILL", "Detached creator did not stop at its accepted-PR boundary");
  const accepted = await Bun.file(join(root, "detached-accepted.json")).json();
  detached = (await publisher.reconcile()).submit!;
  await atomicJson(join(root, "detached-observation.json"), detached);
  check(detached.state === "pending" && detached.snapshot.remote.members.length === 2 && detached.snapshot.remote.candidates.length === 1 &&
    detached.snapshot.remote.candidates[0]!.pr === accepted.pr, "Actual detached PR was not observed");
}
const second = await spawn("recover");
let competing = null;
if (config.competingAppend) {
  const deadline = Date.now() + 120000;
  while (!await Bun.file(join(root, "recovery-paused.json")).exists() && second.child.exitCode === null && Date.now() < deadline) await Bun.sleep(100);
  check(await Bun.file(join(root, "recovery-paused.json")).exists(), "Recovery did not reach its final-observation boundary");
  const directory = join(root, "competitor");
  await command([config.realGit, "clone", `https://github.com/${config.context.repository}.git`, directory]);
  const git = (...args: string[]) => command([config.realGit, ...args], directory);
  const parent = config.context.prefix.at(-1).head, tree = await git("rev-parse", `${parent}^{tree}`);
  const head = await git("commit-tree", tree, "-p", parent, "-m", "test: competing native stack append");
  const context = { ...config.context, directory: await realpath(directory), branch: `codex/eval-append-${crypto.randomUUID().slice(0, 8)}` };
  await git("branch", context.branch, head); await git("switch", context.branch);
  check((await publisher.reconcile()).submit!.state === "pending", "Stack changed before controlled append");
  await atomicJson(join(root, "competing-append-intent.json"), { context, head });
  await appendFile(join(root, "actions.jsonl"), JSON.stringify({ method: "competing-link", pr: null, pid: process.pid, at: new Date().toISOString() }) + "\n");
  await runGuardedStack(stackPushAdmission(context, head, "submit"), ["link", String(context.stack), context.branch, "--remote", "origin"]);
  competing = { context, head, observed: await driver.observe() };
  await atomicJson(join(root, "competing-append-accepted.json"), competing);
  await atomicJson(join(root, "release-recovery.json"), { head });
}
let resumed = { owner: second.owner, exitCode: await second.child.exited, signal: second.child.signalCode };
await atomicJson(join(root, "recover-process.json"), resumed); await requireGroupStopped(second.owner);
let creationStopped = null, creationBoundary = null;
if (config.interruptCreate) {
  creationStopped = resumed;
  creationBoundary = await Bun.file(join(root, "creation-boundary.json")).json();
  check(resumed.exitCode === 137 && resumed.signal === "SIGKILL" && creationBoundary.phase === "created-pr-before-append" &&
    creationBoundary.observed.state === "pending" && creationBoundary.observed.snapshot.remote.candidates.length === 1 &&
    creationBoundary.observed.snapshot.remote.members.length === config.context.prefix.length, "Actual recovery PR-creation interruption missing");
  const finish = await spawn("finish");
  resumed = { owner: finish.owner, exitCode: await finish.child.exited, signal: finish.child.signalCode };
  await atomicJson(join(root, "finish-process.json"), resumed); await requireGroupStopped(finish.owner);
}
const actions = (await Bun.file(join(root, "actions.jsonl")).text()).trim().split("\n").map(v => JSON.parse(v));
if (competing) {
  const current = await driver.observe(), error = await Bun.file(join(root, "recover-error.json")).json();
  let appendRejected = false;
  if (config.appendAfterObservation) {
    const records = join(await command(["git", "rev-parse", "--absolute-git-dir"], config.context.directory), "kgr-stack-appends");
    const entries = await readdir(records);
    if (entries.length === 1) {
      const response = await Bun.file(join(records, entries[0]!, "result.json")).json();
      appendRejected = response.responseVerified === false && response.error.includes("HTTP 422");
    }
  }
  const checks = { actualDetached: detached?.state === "pending", staleRecoveryRejected: resumed.exitCode === 2 && error.error.includes("unexpected remote top"),
    oneCreator: actions.filter(v => v.method === "create-pr").length === 1,
    oneSubmit: actions.filter(v => v.method === "submit").length === 1,
    recoveryLinkBoundary: actions.filter(v => v.method === "link").length === (config.appendAfterObservation ? 1 : 0),
    lateAppendRejected: !config.appendAfterObservation || appendRejected,
    competitorPreserved: current.remote.members.at(-1)?.branch === competing.context.branch && current.remote.members.at(-1)?.head === competing.head,
    originalHeads: config.context.prefix.every((p: any, i: number) => current.remote.members[i]?.head === p.head),
    detachedPreserved: current.remote.candidates.length === 1 && current.remote.candidates[0]!.head === config.head &&
      !current.remote.members.some(p => p.branch === config.context.branch) };
  const result = { passed: Object.values(checks).every(Boolean), checks, partial, detached, creator, stopped, resumed, competing, current, actions, error,
    scope: config.appendAfterObservation
      ? "A competing native append arrived after recovery's final observation. One direct native append request was rejected by GitHub without PR retargeting. This validates the server's base-chain constraint, not conditional head, policy or feedback checks."
      : "Real detached PR seeded after native accepted-push interruption. A competing native append arrived after the recovery claim; final observation rejected stale recovery before its link. Does not prove an atomic check-and-link API transaction." };
  await atomicJson(join(root, "result.json"), result); console.log(JSON.stringify({ passed: result.passed, checks, stack: config.context.stack }));
  if (!result.passed) process.exitCode = 1;
} else {
const final = (await publisher.reconcile()).submit!, again = (await publisher.reconcile()).submit!;
const checks = { actualPartial: partial.state === "pending", resumed: resumed.exitCode === 0 && final.state === "verified",
  onePRCreation: actions.filter(v => v.method === (config.detachedPr ? "create-pr" : "createPR")).length === 1,
  creationResume: !config.interruptCreate || (creationBoundary !== null && creationStopped?.owner.group !== resumed.owner.group),
  detachedRecovery: !config.detachedPr || (detached?.state === "pending" && actions.filter(v => v.method === "create-pr").length === 1 &&
    actions.filter(v => v.method === "link").every(v => v.pr === detached.snapshot.remote.candidates[0]!.pr) &&
    final.pr === detached.snapshot.remote.candidates[0]!.pr),
  stable: again.pr === final.pr && again.head === final.head,
  oneSubmit: actions.filter(v => v.method === "submit").length === 1, oneLink: actions.filter(v => v.method === "link").length === 1,
  oneCommit: await command(["git", "rev-list", "--count", `${config.context.prefix.at(-1).head}..HEAD`], config.context.directory) === "1" };
const result = { passed: Object.values(checks).every(Boolean), checks, partial, detached, creator, creationStopped, creationBoundary, final, actions, stopped, resumed,
  scope: "Real native submit interrupted at accepted push. Branch-only recovery creates a PR at its fixed admitted base, verifies it, then appends it separately. Optional interruptCreate kills the actual recovery worker after creation before append; a fresh worker completes only the append. A separately seeded detached fixture remains available. No in-native-submit PR-creation interruption or general transaction atomicity claim." };
await atomicJson(join(root, "result.json"), result); console.log(JSON.stringify({ passed: result.passed, checks, pr: final.pr, head: final.head }));
if (!result.passed) process.exitCode = 1;
}
}
} finally {
  for (const tracked of workers) {
    const { child, owner } = tracked;
    if (!tracked.terminal) {
      try { check(JSON.stringify(await ownedProcessGroup(child.pid)) === JSON.stringify(owner), "Worker ownership changed before cleanup"); }
      catch (error) { await requireGroupStopped(owner); continue; }
      process.kill(-owner.group, "SIGKILL");
      await child.exited;
    }
    await requireGroupStopped(owner);
  }
}

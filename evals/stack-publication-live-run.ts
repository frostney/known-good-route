import { appendFile, mkdir, open, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { command, digest } from "./github-live.ts";
import { atomicJson } from "./issue-receipt.ts";
import { stackPublisher, type PublicationStep } from "./stack-publication.ts";
import { nativeStackPublicationDriver } from "./stack-publication-driver.ts";
import { runPipeline } from "./stack-program.ts";
import { freezeSnapshot } from "./snapshot.ts";
if (process.env.CI || process.env.GITHUB_ACTIONS || !Bun.argv.includes("--execute")) throw Error("Stack recovery experiment requires explicit local --execute");
const arg = (name: string) => { const i = Bun.argv.indexOf(name); return i < 0 ? undefined : Bun.argv[i + 1]; };
const tracked = (context: any, output: string) => {
  const driver = nativeStackPublicationDriver(context, undefined, { legacySubmit: true });
  for (const [method, step] of [["add", "branch"], ["commit", "commit"], ["submit", "submit"]] as const) {
    const original = driver[method].bind(driver) as (...args: any[]) => Promise<void>;
    (driver as any)[method] = async (...args: any[]) => {
      await appendFile(join(output, "actions.jsonl"), JSON.stringify({ step, pid: process.pid, at: new Date().toISOString() }) + "\n");
      await original(...args);
    };
  }
  return driver;
};
if (arg("--worker")) {
  const output = resolve(arg("--worker")!);
  const config = await Bun.file(join(output, "config.json")).json();
  const step = arg("--step") as PublicationStep;
  const publisher = stackPublisher(config.context, tracked(config.context, output), config.intentDirectory, {
    afterAction: async current => {
      if (current !== step) throw Error("Unexpected mutation boundary");
      const f = await open(join(output, `${step}-boundary.json`), "wx", 0o600);
      try { await f.writeFile(JSON.stringify({ step, pid: process.pid, boundary: "after-command-before-receipt" })); await f.sync(); }
      finally { await f.close(); }
      process.kill(process.pid, "SIGKILL");
      await new Promise(() => {});
    },
  });
  const result = step === "branch" ? await publisher.createBranch() : step === "commit" ?
    await publisher.commit(config.admission, ["README.md"], config.subject) : await publisher.submit(config.head);
  await atomicJson(join(output, `${step}-unexpected-normal-return.json`), result);
  throw Error("The interrupted publisher unexpectedly returned normally");
} else {
  if (!arg("--output") || (!arg("--fixture") && !arg("--resume"))) throw Error("Supply fresh --output and prepared --fixture or stopped --resume evidence");
  const output = resolve(arg("--output")!); await mkdir(output);
  const resumed = arg("--resume") ? resolve(arg("--resume")!) : undefined;
  const priorPlan = resumed ? await Bun.file(join(resumed, "plan.json")).json() : undefined;
  const previous = resumed ? await Bun.file(join(resumed, "config.json")).json() : undefined;
  const fixturePath = priorPlan?.fixture ?? resolve(arg("--fixture")!);
  const fixture = await Bun.file(fixturePath).json();
  if (fixture.repository !== "frostney/kgr-eval-20260906-native-stack" || fixture.repositoryId !== 1358673926 || fixture.stackNumber === 3 || fixture.stackNumber === 6)
    throw Error("Recovery requires a separate prepared stack in the authorized repository");
  const context = previous?.context ?? { repository: fixture.repository, repositoryId: fixture.repositoryId, directory: await realpath(fixture.directory),
    stack: fixture.stackNumber, stackId: fixture.stack.id, baseRef: fixture.defaultBranch, base: fixture.base,
    branch: `codex/eval-stack-recovery-${crypto.randomUUID().slice(0, 8)}`,
    prefix: fixture.stack.pull_requests.map((p: any, i: number) => ({ pr: p.number, branch: fixture.branches[i], head: fixture.localHeads[i] })) };
  const config: any = { ...previous, context, subject: "test: exercise native stack publication recovery",
    intentDirectory: previous?.intentDirectory ?? join(resumed ?? output, "intents") };
  const driver = tracked(context, output), publisher = stackPublisher(context, driver, config.intentDirectory);
  const before = await driver.observe();
  if (!resumed && (before.dirty || before.head.sha !== context.prefix.at(-1).head || before.remote.members.length !== context.prefix.length))
    throw Error("Prepared recovery fixture is not clean at its original top");
  if (resumed) {
    // Resume only after recorded worker death and a fresh liveness probe. Never
    // restart because a polling timeout or absent final result looked terminal.
    for (const step of ["branch", "commit", "submit"]) {
      const file = Bun.file(join(resumed, `${step}-process.json`));
      if (!await file.exists()) continue;
      const receipt = await file.json();
      if (receipt.signal !== "SIGKILL" || receipt.exitCode !== 137) throw Error("Prior worker has no verified SIGKILL boundary");
      try { process.kill(receipt.pid, 0); throw Error("Recorded worker PID is still live or reused; do not resume"); }
      catch (e: any) { if (e.code !== "ESRCH") throw e; }
    }
  }
  const snapshot = join(output, "snapshot"); await freezeSnapshot(snapshot);
  const actionSources = [...(priorPlan?.actionSources ?? (resumed ? [join(resumed, "actions.jsonl")] : [])), join(output, "actions.jsonl")];
  await atomicJson(join(output, "plan.json"), { fixture: fixturePath, context, resumedFrom: resumed ?? null, snapshot,
    intentDirectory: config.intentDirectory, actionSources,
    purpose: "Kill real Bun publishers after official stack add, git commit and official stack submit; recover actual effects without executing those actions again.",
    admission: "Deterministic README-only transport fixture. Visible tests run; seeded source defects remain. No independent model reviewer or readiness certification is claimed.",
    mutationScope: "One additional draft top PR on the separate fixture. Preserve original heads/base and all earlier stacks. No merge, readiness, feedback or policy changes.",
    sources: Object.fromEntries(await Promise.all(["operation-intent.ts", "stack-publication.ts", "stack-publication-driver.ts", "stack-publication-live-run.ts"].map(async name =>
      [name, digest(await Bun.file(join(import.meta.dir, name)).text())]))), before, createdAt: new Date().toISOString() });
  const results = [];
  for (const step of ["branch", "commit", "submit"] as const) {
    const existing = resumed ? (await publisher.reconcile())[step] : undefined;
    if (step === "commit" && !config.admission) {
      const file = join(context.directory, "README.md");
      const body = (await Bun.file(file).text()).trimEnd() + "\n\n## Publication recovery fixture\n\nThis draft layer exercises interrupted branch creation, commit and stack submission.\nIt does not fix or certify the intentionally seeded pipeline defects.\n";
      await Bun.write(file, body);
      const visible = await runPipeline(context.directory, {}, fixture.nodeBinary, true);
      await atomicJson(join(output, "visible-tests.json"), visible);
      if (!visible.passed) throw Error("Visible fixture tests failed before publication");
      config.admission = { revision: digest(body), reviewAttempt: "transport-fixture-no-native-review", gateDigest: digest(JSON.stringify(visible)) };
    }
    if (step === "submit") config.head = (await publisher.reconcile()).commit?.head;
    await atomicJson(join(output, "config.json"), config);
    let processResult;
    if (existing?.state === "verified") {
      const file = join(resumed!, `${step}-process.json`);
      processResult = { ...await Bun.file(file).json(), reusedEvidence: file };
    } else {
      const child = Bun.spawn([process.execPath, join(snapshot, "evals/stack-publication-live-run.ts"), "--execute", "--worker", output, "--step", step], {
        stdout: Bun.file(join(output, `${step}-stdout.log`)), stderr: Bun.file(join(output, `${step}-stderr.log`)), stdin: "ignore",
      });
      processResult = { pid: child.pid, exitCode: await child.exited, signal: child.signalCode };
    }
    await atomicJson(join(output, `${step}-process.json`), processResult);
    // A new publisher instance uses the same persisted intent, not controller state.
    const recovered = await stackPublisher(context, tracked(context, output), config.intentDirectory).reconcile();
    const again = await publisher.reconcile();
    const actions: any[] = [];
    for (const path of actionSources) if (await Bun.file(path).exists())
      actions.push(...(await Bun.file(path).text()).trim().split("\n").filter(Boolean).map(line => JSON.parse(line)));
    const checks = { killed: processResult.signal === "SIGKILL" && processResult.exitCode === 137,
      recovered: recovered[step]?.state === "verified", repeat: again[step]?.state === "verified",
      singleAction: actions.filter(v => v.step === step).length === 1 };
    const row = { step, process: processResult, recovered, checks, passed: Object.values(checks).every(Boolean) };
    results.push(row); await atomicJson(join(output, `${step}-result.json`), row);
    console.log(JSON.stringify({ step, checks, passed: row.passed, pr: recovered.submit?.pr }));
    if (!row.passed) { await atomicJson(join(output, "result.json"), { passed: false, results }); throw Error("Recovery boundary failed; preserve this mutable fixture and reconcile it before further action"); }
  }
  const final = await publisher.reconcile();
  const result = { passed: results.every(r => r.passed), results, final, finishedAt: new Date().toISOString() };
  await atomicJson(join(output, "result.json"), result);
  console.log(JSON.stringify({ passed: result.passed, stack: context.stack, pr: final.submit?.pr, head: final.commit?.head }));
}

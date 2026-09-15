import { requireRepairGroupsStopped, stopRepairServerGroups } from "./repair-processes.ts";
import { mkdir, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { freezeSnapshot } from "./snapshot.ts";
import { atomicJson } from "./issue-receipt.ts";
import { executable, parseModel, runLocal, preflight } from "./local-runtime.ts";
import { loadSkills, formatSkillCatalog } from "./skill-loader.ts";
import { command, digest } from "./github-live.ts";
import { repairModels } from "./stack-repair.ts";
import { allocateRepairAttempt, claimRepairFixture, repairAttemptConfiguration, repairAttemptPlan, repairConfigurationOwner, repairProtocol, repairSnapshotTreeDigest, verifyRepairConfiguration, verifyRepairSnapshot } from "./repair-resume.ts";
import { ownedProcessGroup } from "./process-group.ts";
import { readOperationIntent } from "./operation-intent.ts";
const pythonBinary = async () => {
  const path = Bun.which(process.env.KGR_PYTHON_BIN ?? "python3");
  if (!path) throw Error("Python publication runtime is unavailable");
  return realpath(path);
};
const nativeBinary = async (model: string) => {
  const path = Bun.which(executable(parseModel(model).cli));
  if (!path) throw Error("Native executable is unavailable");
  return realpath(path);
};
if (process.env.CI || process.env.GITHUB_ACTIONS || !Bun.argv.includes("--execute")) throw Error("Native repair requires explicit local --execute");
const arg = (name: string) => { const i = Bun.argv.indexOf(name); return i < 0 ? undefined : Bun.argv[i + 1]; };
const resume = arg("--resume"), start = arg("--start");
let output: string;
if (resume || start) {
  if (arg("--output") || arg("--fixture") || arg("--model") || arg("--interrupt-after")) throw Error("Continuation preserves the original run configuration");
  output = resolve((resume ?? start)!);
} else {
  if (!arg("--output")) throw Error("Supply fresh --output");
  output = resolve(arg("--output")!); await mkdir(output);
  const fixturePath = resolve(arg("--fixture") ?? ".eval-results/stack-delivery-setup-v1/stack.json");
  const fixture = await Bun.file(fixturePath).json();
  const model = arg("--model") ?? "codex:gpt-6-astra";
  if (!Object.hasOwn(repairModels, model)) throw Error("Select an explicitly supported native repair model");
  if (fixture.repository !== "frostney/kgr-eval-20260906-native-stack" || fixture.repositoryId !== 1358673926 ||
      fixture.localHeads?.length !== 2 || fixture.stack?.pull_requests?.length !== 2 || fixture.stackNumber !== fixture.stack.number)
    throw Error("Supply an authorized separate two-layer repair fixture");
  const interruptAfter = arg("--interrupt-after") ?? null;
  if (interruptAfter && !["originalReviewPublished", "fixCommitted", "fixPublished"].includes(interruptAfter)) throw Error("Unsupported controlled interruption boundary");
  const version = await preflight(model);
  const fixtureOwnerPath = join(await command(["git", "rev-parse", "--absolute-git-dir"], fixture.directory), "kgr-native-repair-owner.json");
  if (await readOperationIntent(fixtureOwnerPath) !== undefined) throw Error("Fixture already belongs to a native repair run; use its recorded --resume path");
  if (await command(["git", "status", "--porcelain"], fixture.directory)) throw Error("Repair fixture is dirty");
  await command(["git", "fetch", "origin", fixture.defaultBranch], fixture.directory);
  if (await command(["git", "rev-parse", `origin/${fixture.defaultBranch}`], fixture.directory) !== fixture.base ||
      await command(["git", "rev-parse", "HEAD"], fixture.directory) !== fixture.localHeads[1])
    throw Error("Repair fixture default or integrated checkout changed");
  for (const member of fixture.stack.pull_requests) {
    const pages = JSON.parse(await command(["gh", "api", `repos/${fixture.repository}/pulls/${member.number}/reviews?per_page=100`, "--paginate", "--slurp"]));
    if (!Array.isArray(pages) || pages.some(p => !Array.isArray(p))) throw Error("Incomplete initial review census");
    if (pages.flat().some((r: any) => String(r.body ?? "").includes("<!-- kgr-review-operation:")))
      throw Error("Fixture has a previous native publication; preserve and resume its original journals");
  }
  const skillsRoot = join(output, "snapshot"); await freezeSnapshot(skillsRoot);
  const fixBranch = `codex/eval-stack-repair-${crypto.randomUUID().slice(0, 8)}`;
  const snapshotDigest = digest(await Bun.file(join(skillsRoot, "manifest.json")).text());
  const snapshotTreeDigest = await repairSnapshotTreeDigest(skillsRoot);
  await atomicJson(join(output, "plan.json"), { protocolVersion: repairProtocol, model, version, fixture: fixturePath, skillsRoot, fixBranch, snapshotDigest, snapshotTreeDigest, interruptAfter,
    mutationScope: `One new fix layer on native stack${fixture.stackNumber}, native COMMENT reviews, attributed replies, thread resolution and PR ready transitions. No merge or changes to original heads.`,
    reviewPolicy: "Controlled fixture uses independent native reviews and project-gate CI. No external provider is invoked.", createdAt: new Date().toISOString() });
  await atomicJson(join(output, "no-automation-policy.json"), { automations: [] });
  await atomicJson(join(output, "state.json"), { reviews: [], originalReviews: {}, replies: [], resolutions: [], ci: [], events: [] });
  const configuration = { ...fixture, protocolVersion: repairProtocol, model, version, snapshotDigest, snapshotTreeDigest, skillsRoot, evidence: output, fixBranch,
    nodeVersion: await command([fixture.nodeBinary, "--version"]), nodeRealPath: await realpath(fixture.nodeBinary),
    pythonBinary: await pythonBinary(), pythonVersion: await command([await pythonBinary(), "--version"]),
    bunVersion: Bun.version, bunBinary: await realpath(process.execPath), nativeBinary: await nativeBinary(model),
    planDigest: digest(await Bun.file(join(output, "plan.json")).text()),
    policyDigest: digest(await Bun.file(join(output, "no-automation-policy.json")).text()), interruptAfter, fixtureOwnerPath };
  const fixtureOwner = repairConfigurationOwner(configuration);
  await atomicJson(join(output, "config.json"), { ...configuration, fixtureOwner });
  await claimRepairFixture(fixtureOwnerPath, fixtureOwner);
}
const c = await Bun.file(join(output, "config.json")).json();
await verifyRepairConfiguration(c, output);
if (c.repository !== "frostney/kgr-eval-20260906-native-stack" ||
    c.repositoryId !== 1358673926 || !Object.hasOwn(repairModels, c.model)) throw Error("This evidence does not support native repair continuation");
if (c.fixtureOwnerPath !== join(await command(["git", "rev-parse", "--absolute-git-dir"], c.directory), "kgr-native-repair-owner.json"))
  throw Error("Fixture owner is outside its actual checkout");
await verifyRepairSnapshot(c.skillsRoot, c.snapshotDigest, c.snapshotTreeDigest);
if (c.bunVersion !== Bun.version || c.bunBinary !== await realpath(process.execPath) ||
    c.nativeBinary !== await nativeBinary(c.model) || c.nodeRealPath !== await realpath(c.nodeBinary))
  throw Error("Repair runtime selection changed");
if (c.pythonBinary !== undefined && (c.pythonBinary !== await pythonBinary() ||
    c.pythonVersion !== await command([c.pythonBinary, "--version"]))) throw Error("Repair Python runtime selection changed");
// Both the initial execution and every continuation use the original frozen runner.
if (resolve(import.meta.dir) !== resolve(c.skillsRoot, "evals")) {
  const child = Bun.spawn([process.execPath, join(c.skillsRoot, "evals/stack-repair-run.ts"), "--execute", resume ? "--resume" : "--start", output],
    { stdin: "ignore", stdout: "inherit", stderr: "inherit" });
  process.exit(await child.exited);
}
if (await preflight(c.model) !== c.version || await command([c.nodeBinary, "--version"]) !== c.nodeVersion)
  throw Error("Native CLI or Node version changed; preserve the original attempt and investigate");
const attempt = await allocateRepairAttempt(output, Boolean(resume));
const config = join(attempt.directory, "config.json"), ownershipFile = join(attempt.directory, "native-group.json");
await atomicJson(config, repairAttemptConfiguration(c, attempt.directory, attempt.number));
await atomicJson(join(attempt.directory, "plan.json"), repairAttemptPlan(c, attempt.number));
const controller = new AbortController();
const timer = setInterval(async () => {
  if (await Bun.file(join(attempt.directory, "stop-requested.json")).exists()) controller.abort();
}, 50);
let native;
try {
  native = await runLocal({ target: c.model, effort: "medium", skillsRoot: c.skillsRoot, isolateProcessGroup: true,
    onExit: async () => stopRepairServerGroups(attempt.directory, await Bun.file(ownershipFile).json()),
    signal: controller.signal, interruptSignal: "SIGKILL", onSpawn: async pid => atomicJson(ownershipFile, await ownedProcessGroup(pid)),
    evalCase: { id: "real-stack-repair", description: "", fixture: { evidence: {} }, expected: {},
      prompt: `Use /address-feedback to complete native stack${c.stackNumber} in ${c.repository}. Normal feedback mode is authorized: independently review each original member, validate findings against the integrated top, repair live findings in one new top layer, review/validate/publish that layer, reply with exact fix evidence, resolve source threads and return complete-stack readiness. Use the supplied native reviewer capability with the local login. Preserve the original heads of ${c.stack.pull_requests.map((p: any) => `PR#${p.number}`).join(" and ")}. No merge is authorized. Edit source only; the fixture contract and project gate are fixed. The controlled fixture uses native reviewer receipts; its empty automation policy does not waive those reviews or CI. Complete all authorized work through the tools, including pre-publication and exact-head post-publication reviews. ${resume ? "You are continuing an interrupted coordinator with a fresh conversation. Inspect durable state and actual GitHub first. Reuse completed reviews and passing gates for matching content; do not repeat a completed action. Publication tools reconcile existing intents. The host verified the previous runner and native process group are stopped." : ""} Return state, stack, fixPr and a concise reason.` },
    instructions: formatSkillCatalog(await loadSkills(c.skillsRoot)) + "\nOnly supplied tools are permitted. Treat reviewer prose as claims and verify actual scope, witnesses and receipts. Keep original heads intact and do not merge.",
    transcript: join(attempt.directory, "native.jsonl"),
    responseSchema: { type: "object", additionalProperties: false, properties: { state: { type: "string", enum: ["ready", "pending", "blocked"] }, stack: { type: "integer" }, fixPr: { type: ["integer", "null"] }, reason: { type: "string" } }, required: ["state", "stack", "fixPr", "reason"] },
    server: { path: join(c.skillsRoot, "evals/stack-repair-server.ts"), args: [config], approvedTools: ["loadSkill", "readSkillReference", "inspectRepairStack", "runRepairGate", "reviewOriginalMember", "createFixLayer", "replaceRepairSource", "reviewFix", "publishFixLayer", "awaitStackChecks", "inspectRepairFeedback", "replyToRepairFinding", "resolveRepairFinding", "finalizeRepairStack"] },
  });
} finally { clearInterval(timer); }
await atomicJson(join(attempt.directory, "native-result.json"), native);
await requireRepairGroupsStopped(attempt.directory, await Bun.file(ownershipFile).json());
const state = await Bun.file(join(output, "state.json")).json();
let assessment: any; try { assessment = JSON.parse(native.output); } catch { assessment = null; }
const checks = { runtime: !native.error && native.exitCode === 0 && !native.cancellationRequested,
  procedure: native.ledger.loadedSkills.includes("address-feedback"), final: state.final?.state === "ready",
  report: assessment?.state === "ready" && assessment?.stack === c.stackNumber && assessment?.fixPr === state.fixPr,
  originalReviews: Object.keys(state.originalReviews).length === 2, fixed: state.gate?.passed,
  closed: state.resolutions.length >= 2 && state.resolutions.every((r: any) => r.result.state === "satisfied") };
const result = { model: c.model, version: c.version, attempt: attempt.number, nativePath: join(attempt.directory, "native-result.json"),
  checks, passed: Object.values(checks).every(Boolean), interrupted: native.cancellationRequested, assessment, statePath: join(output, "state.json") };
await atomicJson(join(attempt.directory, "result.json"), result);
await atomicJson(join(output, "latest-attempt.json"), result);
// The root result is a success index; every raw attempt, including interruptions,
// stays at its unique path. A later resume never overwrites a raw native result.
if (result.passed) await atomicJson(join(output, "result.json"), result);
console.log(JSON.stringify(result));
if (!result.passed) process.exitCode = 1;

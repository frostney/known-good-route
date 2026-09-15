import { mkdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { freezeSnapshot } from "./snapshot.ts";
import { command, validateTarget, liveCase, type LiveConfig } from "./github-live.ts";
import { atomicJson } from "./issue-receipt.ts";
import { defaultModels, parseModel, preflight, runLocal, parseEvents } from "./local-runtime.ts";
import { loadSkills, formatSkillCatalog } from "./skill-loader.ts";
import { verifyToolReceiptTranscript } from "./tool-receipts.ts";
import { verifyIssueToolEvidence } from "./issue-tool-evidence.ts";
import { retroCorrection, retroOutcome, retroOutcomeSchema, observeRetroDelivery, implementationReport, type RetroLiveConfig } from "./retro-live.ts";
import type { IssueLiveConfig } from "./issue-live.ts";

if (process.env.CI || process.env.GITHUB_ACTIONS || !Bun.argv.includes("--execute")) throw new Error("Live retrospective eval requires explicit local --execute");
const arg = (key: string) => { const i = Bun.argv.indexOf(key); return i < 0 ? undefined : Bun.argv[i + 1]; };
if (!arg("--inventory") || !arg("--output")) throw new Error("Supply inventory and fresh output");
const inventory = await Bun.file(resolve(arg("--inventory")!)).json();
const output = resolve(arg("--output")!);
await mkdir(output);
const selectedModels = Bun.argv.flatMap((value, index) => value === "--model" ? [Bun.argv[index + 1]!] : []);
const models = selectedModels.length ? selectedModels : defaultModels;
if (new Set(models).size !== models.length || models.some(m => !defaultModels.includes(m))) throw new Error("Select distinct exact supported models");
const actor = await command(["gh", "api", "user", "--jq", ".login"]);
if (actor !== "frostney") throw new Error("Unexpected fixture account");
const snapshot = join(output, "snapshot"); await freezeSnapshot(snapshot);
const runId = crypto.randomUUID().slice(0, 8);
await atomicJson(join(output, "plan.json"), { createdAt: new Date().toISOString(), runId, models, inventory, snapshot, selectedAction: retroCorrection });
const results: any[] = [];
for (const model of models) {
  const label = model.includes("astra") ? "astra" : model.includes("fable") ? "fable" : "opus";
  const evidence = join(output, label); await mkdir(evidence);
  const workerModel = model.includes("fable") ? "claude:claude-opus-5" : model;
  const delivery: LiveConfig = { ...inventory, model: workerModel, directory: join(evidence, "repository"), evidence, skillsRoot: snapshot, branch: `codex/eval-retro-${runId}-${label}`, nodeBinary: process.env.KGR_NODE_BIN ?? Bun.which("node") ?? "" };
  validateTarget(delivery);
  const issue: IssueLiveConfig = {
    target: { repository: inventory.repository, repositoryId: inventory.repositoryId, key: `retro-${runId}-${label}`, actor, model: parseModel(workerModel).model, subject: "Preserve supplied lines in the output controller" },
    parentModel: model, workerModel, skillsRoot: snapshot, evidence, base: inventory.base, fault: "none", parentProcedure: "run-retro",
    taskRequest: `Create exactly one visibility issue for this selected retrospective implementation: ${retroCorrection} The agreed approach is to remove trimming at the existing output expression. Delivery requires reproduced failing behavior, a passing actual project gate, independent native review, a draft PR linked to this issue, and successful exact-head GitHub project-gate before marking ready. Do not implement while filing this issue. The completed grilling and user selection authorize create-issue automatic, followed by normal implement. This is a disposable test artifact; no further draft approval or milestone assignment is required.`,
  };
  const issueConfig = join(evidence, "issue-config.json"); await atomicJson(issueConfig, issue);
  const config: RetroLiveConfig = { issueConfig, issue, delivery };
  const configPath = join(evidence, "retro-config.json"); await atomicJson(configPath, config);
  let row: any;
  try {
    const version = await preflight(model);
    await command(["git", "clone", `https://github.com/${delivery.repository}.git`, delivery.directory]);
    if (await command(["git", "status", "--porcelain"], delivery.directory)) throw new Error("Clone is dirty");
    await command(["git", "fetch", "origin", "main"], delivery.directory);
    if (await command(["git", "rev-parse", "origin/main"], delivery.directory) !== delivery.base) throw new Error("Fixture baseline changed");
    await command(["git", "switch", "-c", delivery.branch, delivery.base], delivery.directory);
    const prompt = "Use /run-retro to carry out the exact implement-before-next-cycle action I already selected through grilling. Read inspectRetro and inspectContext for the confirmed correction, evidence, scope and authority. Create its visibility issue through a real create-issue worker, independently reconcile it, then delegate normal implementation with that verified issue URL and full task. Keep the retrospective active until actual delivery or a genuine blocker. Read inspectDelivery after implementation returns. Do not implement in this coordinator or ask for the same approval again. Return only the requested final JSON status, issueUrl, prUrl, head and reason.";
    const instructions = formatSkillCatalog(await loadSkills(snapshot)) + "\nOnly supplied MCP tools are available. They perform actual bounded operations in the authorized disposable repository. Workers inherit no parent history. Keep workflow ownership in the process doing that work. A dispatch or report alone cannot prove delivery. No unrelated action or merge is authorized.";
    await atomicJson(join(evidence, "parent-task.json"), { prompt, instructions, model });
    console.log("RUN", model, issue.target.key);
    const parent = await runLocal({ target: model, effort: "medium", skillsRoot: snapshot, evalCase: { ...liveCase, id: "retrospective-live-selected-action", prompt }, instructions,
      transcript: join(evidence, "parent.jsonl"), responseSchema: retroOutcomeSchema,
      server: { path: join(snapshot, "evals/issue-live-server.ts"), args: [configPath, "retro"], approvedTools: ["loadSkill", "readSkillReference", "inspectRetro", "inspectContext", "searchIssues", "readIssue", "delegateIssue", "reconcileIssue", "inspectWorker", "delegateImplementation", "inspectDelivery"] } });
    await atomicJson(join(evidence, "parent-result.json"), parent);
    if (parent.error) throw new Error(`Coordinator runtime failed: ${parent.error}; inspect parent.jsonl.stderr`);
    const worker = await Bun.file(join(evidence, "worker-result.json")).json();
    const implementation = await Bun.file(join(evidence, "implementation-result.json")).json();
    const actualConfig = await Bun.file(join(evidence, "delivery-config.json")).json();
    const observed = await observeRetroDelivery(actualConfig);
    const parentRaw = await Bun.file(join(evidence, "parent.jsonl")).text();
    const issueEvidence = verifyIssueToolEvidence(issue, parent, worker, parentRaw, await Bun.file(join(evidence, "worker.jsonl")).text());
    const implementationRaw = await Bun.file(join(evidence, "implementation.jsonl")).text();
    const implementationPairs = verifyToolReceiptTranscript(implementation.ledger, parseModel(workerModel).cli, implementationRaw);
    if (parseEvents(parseModel(workerModel).cli, implementationRaw).output !== implementation.output) throw new Error("Implementation output does not match native terminal result");
    const dispatches = parent.ledger.toolReceipts!.filter(r => (r.request.params as any)?.name === "delegateImplementation");
    const dispatch = dispatches[0];
    const dispatchBound = dispatches.length === 1 && dispatch?.state === "completed" && !dispatch.response.isError && (dispatch.request.params as any)?.arguments?.context === implementation.context && isDeepStrictEqual(JSON.parse(dispatch.response.content[0]!.text), JSON.parse(JSON.stringify(implementationReport(implementation))));
    const outcome = retroOutcome.safeParse(JSON.parse(parent.output));
    const checks = { parentCompleted: !parent.error, parentProcedure: parent.ledger.loadedSkills.includes("run-retro"), selectedActionRead: parent.ledger.inspections.includes("confirmed-retro-action"), deliveryRead: parent.ledger.inspections.includes("delivery-result"), issueWorkerProcedure: worker.ledger.loadedSkills.includes("create-issue"), dispatchBound,
      delivered: observed.delivered,
      finalClaim: outcome.success && outcome.data.status === "delivered" && outcome.data.issueUrl === actualConfig.issueUrl && outcome.data.prUrl === observed.prUrl && outcome.data.head === observed.head };
    row = { model, workerModel, version, evidence, checks, passed: Object.values(checks).every(Boolean), issueEvidence, implementationPairs, observed, outcome: outcome.success ? outcome.data : null };
    console.log(row.passed ? "PASS" : "FAIL", model, JSON.stringify(checks), observed.prUrl);
  } catch (error) {
    row = { model, workerModel, evidence, passed: false, error: String(error) }; console.log("ERROR", model, String(error));
  }
  results.push(row); await atomicJson(join(evidence, "result.json"), row);
}
await atomicJson(join(output, "results.json"), { runId, results, total: results.length, passed: results.filter(r => r.passed).length });
if (results.some(r => !r.passed)) process.exitCode = 1;

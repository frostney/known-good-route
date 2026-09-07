import { mkdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { freezeSnapshot } from "./snapshot.ts";
import { command } from "./github-live.ts";
import {
  preflight,
  runLocal,
  defaultModels,
  parseModel,
} from "./local-runtime.ts";
import { loadSkills, formatSkillCatalog } from "./skill-loader.ts";
import {
  issueCase,
  githubIssueForge,
  type IssueLiveConfig,
} from "./issue-live.ts";
import {
  issueOutcomeSchema,
  atomicJson,
  readCheckpoint,
  reconcileIssue,
  validateIssueTarget,
} from "./issue-receipt.ts";
import { gradeIssueDelivery } from "./issue-live-grade.ts";
import { verifyIssueToolEvidence } from "./issue-tool-evidence.ts";
if (
  process.env.CI ||
  process.env.GITHUB_ACTIONS ||
  !Bun.argv.includes("--execute")
)
  throw new Error(
    "Live issue evaluations require explicit local --execute outside CI",
  );
const arg = (name: string) => {
  const i = Bun.argv.indexOf(name);
  return i < 0 ? undefined : Bun.argv[i + 1];
};
if (!arg("--inventory") || !arg("--output"))
  throw new Error("Supply --inventory and fresh --output");
const output = resolve(arg("--output")!);
await mkdir(output); // Refuse accidental reuse, including incomplete prior runs.
const inventory = await Bun.file(resolve(arg("--inventory")!)).json();
const models = arg("--model") ? [arg("--model")!] : defaultModels;
if (models.some((m) => !defaultModels.includes(m)))
  throw new Error("Use an exact supported model");
const scenarios = arg("--scenario")
  ? [arg("--scenario")!]
  : ["normal", "missing-identity", "interrupted"];
if (
  scenarios.some(
    (s) => !["normal", "missing-identity", "interrupted"].includes(s),
  )
)
  throw new Error("Invalid scenario");
const actor = await command(["gh", "api", "user", "--jq", ".login"]);
if (actor !== "frostney")
  throw new Error("Unexpected authenticated test owner");
const skillsRoot = join(output, "snapshot");
await freezeSnapshot(skillsRoot);
const runId = crypto.randomUUID().slice(0, 8);
const jobs = models.flatMap((parentModel) =>
  scenarios.map((scenario) => ({ parentModel, scenario })),
);
await atomicJson(join(output, "plan.json"), {
  createdAt: new Date().toISOString(),
  runId,
  jobs,
  inventory,
  manifest: join(skillsRoot, "manifest.json"),
  runtime: {
    bun: Bun.version,
    dependencies:
      "isolated copied dependencies from frozen lock; source and dependency manifests retained",
  },
});
const results: any[] = [];
// Two active parent jobs bound native fan-out; each parent has at most one worker.
let next = 0;
async function consume() {
  while (next < jobs.length) {
    const { parentModel, scenario } = jobs[next++]!;
    const label = parentModel.includes("astra")
      ? "astra"
      : parentModel.includes("fable")
        ? "fable"
        : "opus";
    const evidence = join(output, `${label}-${scenario}`);
    await mkdir(evidence);
    const workerModel = parentModel.includes("fable")
      ? "claude:claude-opus-5"
      : parentModel;
    const c: IssueLiveConfig = {
      target: {
        repository: inventory.repository,
        repositoryId: inventory.repositoryId,
        key: `${runId}-${label}-${scenario}`,
        actor: scenario === "missing-identity" ? null : actor,
        model:
          scenario === "missing-identity"
            ? null
            : parseModel(workerModel).model,
      },
      parentModel,
      workerModel,
      skillsRoot,
      evidence,
      base: inventory.base,
      fault: scenario === "interrupted" ? "interrupt-after-post" : "none",
    };
    validateIssueTarget(c.target);
    const config = join(evidence, "config.json");
    await atomicJson(config, c);
    let row: any;
    try {
      const version = await preflight(parentModel);
      console.log("RUN", label, scenario, c.target.key);
      const parent = await runLocal({
        target: parentModel,
        effort: "medium",
        skillsRoot,
        evalCase: {
          ...issueCase,
          prompt: `Use milestone-rush's prerequisite-filing procedure for one explicitly authorized test issue in ${c.target.repository}. Inspect context and delegate the bounded create-issue automatic task through delegateIssue. No implementation, milestone assignment or infrastructure change is authorized. Carry evidence, scope and observed attribution into the isolated worker packet. Observe its actual result, then use reconcileIssue to verify the external outcome. If the worker is interrupted, recover by reading GitHub and the checkpoint; do not blindly restart or post again. This is an authorized disposable-repository eval; no additional posting approval is needed. Final response must be exactly one JSON object with status (created, existing, recovered, blocked or unknown), issueUrl (verified URL or null), and reason; no prose outside JSON.`,
        },
        instructions:
          formatSkillCatalog(await loadSkills(skillsRoot)) +
          "\nOnly provided MCP tools are available. They operate on the actual bounded disposable repository. DelegateIssue launches a real native worker with no inherited history. A worker invocation or acknowledged request is never evidence of issue creation. Do not invent unavailable identity.",
        transcript: join(evidence, "parent.jsonl"),
        responseSchema: issueOutcomeSchema,
        server: {
          path: join(skillsRoot, "evals/issue-live-server.ts"),
          args: [config, "parent"],
          approvedTools: [
            "loadSkill",
            "readSkillReference",
            "inspectContext",
            "searchIssues",
            "readIssue",
            "reconcileIssue",
            "delegateIssue",
          ],
        },
      });
      await atomicJson(join(evidence, "parent-result.json"), parent);
      const worker = (await Bun.file(
        join(evidence, "worker-result.json"),
      ).exists())
        ? await Bun.file(join(evidence, "worker-result.json")).json()
        : undefined;
      const receipt = (await Bun.file(
        join(evidence, "parent-receipt.json"),
      ).exists())
        ? await Bun.file(join(evidence, "parent-receipt.json")).json()
        : undefined;
      const forge = githubIssueForge(c.target);
      const observed = await reconcileIssue(
        c.target,
        forge,
        join(evidence, "issue-checkpoint.json"),
      );
      const issues = await forge.list();
      const checkpoint = await readCheckpoint(
        join(evidence, "issue-checkpoint.json"),
      );
      const events = (await Bun.file(
        join(evidence, "worker-events.jsonl"),
      ).exists())
        ? (await Bun.file(join(evidence, "worker-events.jsonl")).text())
            .trim()
            .split("\n")
            .filter(Boolean)
            .map((line) => JSON.parse(line))
        : [];
      const grade = gradeIssueDelivery(
        c,
        parent,
        worker,
        receipt,
        issues,
        checkpoint,
        events,
      );
      const toolEvidence = verifyIssueToolEvidence(
        c, parent, worker,
        await Bun.file(join(evidence, "parent.jsonl")).text(),
        await Bun.file(join(evidence, "worker.jsonl")).text(),
      );
      await atomicJson(join(evidence, "tool-evidence.json"), toolEvidence);
      row = {
        parentModel,
        workerModel,
        scenario,
        version,
        ...grade,
        toolEvidence,
        observed,
        receipt,
        checkpoint,
        evidence,
      };
      console.log(
        grade.passed ? "PASS" : "FAIL",
        label,
        scenario,
        JSON.stringify(grade.checks),
        receipt?.issueUrl,
      );
    } catch (e) {
      row = {
        parentModel,
        workerModel,
        scenario,
        passed: false,
        error: String(e),
        evidence,
      };
      console.log("ERROR", label, scenario, String(e));
    }
    results.push(row);
    await atomicJson(join(evidence, "result.json"), row);
  }
}
await Promise.all([consume(), consume()]);
await atomicJson(join(output, "results.json"), {
  runId,
  results,
  passed: results.filter((r) => r.passed).length,
  total: results.length,
});
if (results.some((r) => !r.passed)) process.exitCode = 1;

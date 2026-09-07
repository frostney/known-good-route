import { mkdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { freezeSnapshot } from "./snapshot.ts";
import { command } from "./github-live.ts";
import {
  runLocal,
  preflight,
  defaultModels,
  parseModel,
} from "./local-runtime.ts";
import { loadSkills, formatSkillCatalog } from "./skill-loader.ts";
import {
  atomicJson,
  issueOutcomeSchema,
  parseIssueOutcome,
  markerFor,
  matchesIssue,
  readCheckpoint,
  reconcileIssueWithDeadline,
} from "./issue-receipt.ts";
import {
  issueCase,
  githubIssueForge,
  workerFile,
  type IssueLiveConfig,
} from "./issue-live.ts";
import {
  processIdentity,
  waitForProcessesStopped,
  type ProcessIdentity,
} from "./process-identity.ts";
if (
  process.env.CI ||
  process.env.GITHUB_ACTIONS ||
  !Bun.argv.includes("--execute")
)
  throw new Error(
    "Coordinator recovery requires explicit local --execute outside CI",
  );
const arg = (name: string) => {
  const i = Bun.argv.indexOf(name);
  return i < 0 ? undefined : Bun.argv[i + 1];
};
if (!arg("--inventory") || !arg("--output"))
  throw new Error("Supply --inventory and fresh --output");
const selectedSignal = arg("--interrupt-signal") ?? "SIGTERM";
if (selectedSignal !== "SIGTERM" && selectedSignal !== "SIGKILL")
  throw new Error(
    "Choose SIGTERM or SIGKILL for controlled coordinator interruption",
  );
const interruptSignal: "SIGTERM" | "SIGKILL" = selectedSignal;
const output = resolve(arg("--output")!);
await mkdir(output);
const inventory = await Bun.file(resolve(arg("--inventory")!)).json();
const models = arg("--model") ? [arg("--model")!] : defaultModels;
if (models.some((m) => !defaultModels.includes(m)))
  throw new Error("Choose exact native models");
const scenarios = arg("--scenario")
  ? [arg("--scenario")!]
  : ["during-worker-read", "after-worker-result"];
if (
  scenarios.some(
    (s) => !["during-worker-read", "after-worker-result"].includes(s),
  )
)
  throw new Error("Invalid recovery scenario");
const actor = await command(["gh", "api", "user", "--jq", ".login"]);
if (actor !== "frostney") throw new Error("Unexpected test owner");
const skillsRoot = join(output, "snapshot");
await freezeSnapshot(skillsRoot);
const catalog = formatSkillCatalog(await loadSkills(skillsRoot));
const runId = crypto.randomUUID().slice(0, 8),
  jobs = models.flatMap((model) =>
    scenarios.map((scenario) => ({ model, scenario })),
  );
await atomicJson(join(output, "plan.json"), {
  runId,
  interruptSignal,
  jobs,
  inventory,
  source: join(skillsRoot, "manifest.json"),
  dependencies: join(skillsRoot, "dependencies-manifest.json"),
});
const events = async (path: string) =>
  (await Bun.file(path).exists())
    ? (await Bun.file(path).text())
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : [];
const results: any[] = [];
let next = 0;
async function consume() {
  while (next < jobs.length) {
    const { model, scenario } = jobs[next++]!;
    const label = model.includes("astra")
      ? "astra"
      : model.includes("fable")
        ? "fable"
        : "opus";
    const evidence = join(output, `${label}-${scenario}`);
    await mkdir(evidence);
    const workerModel = model.includes("fable")
      ? "claude:claude-opus-5"
      : model;
    const c: IssueLiveConfig = {
      target: {
        repository: inventory.repository,
        repositoryId: inventory.repositoryId,
        key: `${runId}-${label}-${scenario}`,
        actor,
        model: parseModel(workerModel).model,
      },
      parentModel: model,
      workerModel,
      skillsRoot,
      evidence,
      base: inventory.base,
      fault: "none",
      coordinatorFault: scenario as NonNullable<
        IssueLiveConfig["coordinatorFault"]
      >,
      workerAttempt: 1,
    };
    const config1 = join(evidence, "config-1.json");
    await atomicJson(config1, c);
    let row: any;
    try {
      const version = await preflight(model);
      const forge = githubIssueForge(c.target);
      const controller = new AbortController();
      const timer = setInterval(async () => {
        if (
          await Bun.file(
            join(evidence, "coordinator-stop-requested.json"),
          ).exists()
        )
          controller.abort();
      }, 50);
      const runParent = (
        config: string,
        phase: number,
        prompt: string,
        signal?: AbortSignal,
      ) =>
        runLocal({
          target: model,
          effort: "medium",
          skillsRoot,
          evalCase: { ...issueCase, prompt },
          instructions:
            catalog +
            "\nUse only provided real bounded GitHub tools. No implementation or unrelated writes. Parent history is not inherited on restart. Return status, issueUrl and reason through the configured structured output. Inspect durable evidence and live GitHub; never infer completion from dispatch or restart a live worker.",
          transcript: join(evidence, `parent-${phase}.jsonl`),
          responseSchema: issueOutcomeSchema,
          interruptSignal,
          ...(signal ? { signal } : {}),
          onSpawn: async (pid) => {
            await atomicJson(
              join(evidence, `parent-${phase}-process.json`),
              await processIdentity(pid),
            );
          },
          server: {
            path: join(skillsRoot, "evals/issue-live-server.ts"),
            args: [config, "parent"],
            approvedTools: [
              "loadSkill",
              "readSkillReference",
              "inspectContext",
              "searchIssues",
              "readIssue",
              "inspectWorker",
              "delegateIssue",
              "reconcileIssue",
            ],
          },
        });
      console.log("RUN", label, scenario, "initial coordinator");
      let first;
      try {
        first = await runParent(
          config1,
          1,
          `Use milestone-rush's prerequisite-filing procedure for one authorized disposable issue in ${c.target.repository}. Inspect context, delegate a bounded create-issue automatic task through delegateIssue, inspect the actual worker result and independently reconcile GitHub. No implementation, milestone changes or other writes. Exact issue-author identity must come from observed context. A second draft approval is waived.`,
          controller.signal,
        );
      } finally {
        clearInterval(timer);
      }
      await atomicJson(join(evidence, "parent-1-result.json"), first);
      if (!first.error || !first.cancellationRequested)
        throw new Error(
          "Coordinator did not reach the controlled interruption; preserve this failed trial",
        );
      const stop = await Bun.file(
        join(evidence, "coordinator-stop-requested.json"),
      ).json();
      const identities: ProcessIdentity[] = [
        await Bun.file(join(evidence, "parent-1-process.json")).json(),
        ...stop.processes,
      ];
      // The transport may need a moment to finish cancelling and persist its worker receipt.
      for (
        let i = 0;
        i < 100 && !(await Bun.file(workerFile(c, "-result.json")).exists());
        i++
      )
        await new Promise((r) => setTimeout(r, 100));
      for (const role of ["parent", "worker"])
        for (const e of await events(join(evidence, `${role}-events.jsonl`)))
          if (e.action === "serverStarted") identities.push(e.data.identity);
      identities.push(await Bun.file(workerFile(c, "-process.json")).json());
      await waitForProcessesStopped(identities);
      const firstWorker = (await Bun.file(
        workerFile(c, "-result.json"),
      ).exists())
        ? await Bun.file(workerFile(c, "-result.json")).json()
        : null;
      const partialTrace = (await Bun.file(workerFile(c, ".jsonl")).exists())
        ? await Bun.file(workerFile(c, ".jsonl")).text()
        : "";
      const preRestartEvents = await events(
        join(evidence, "worker-events.jsonl"),
      );
      const initialIssues = (await forge.list()).filter(
        (i) => !i.pull_request && (i.body ?? "").includes(markerFor(c.target)),
      );
      const beforeCheckpoint = await readCheckpoint(
        join(evidence, "issue-checkpoint.json"),
      );
      if (
        scenario === "during-worker-read" &&
        (initialIssues.length ||
          beforeCheckpoint ||
          preRestartEvents.some((e) => e.action === "postRequest") ||
          !partialTrace ||
          (firstWorker &&
            (!firstWorker.error || !firstWorker.cancellationRequested)))
      )
        throw new Error(
          "Interrupted read did not establish a stopped, write-free worker",
        );
      if (
        scenario === "after-worker-result" &&
        (!firstWorker ||
          firstWorker.error ||
          beforeCheckpoint?.phase !== "verified")
      )
        throw new Error(
          "Terminal worker receipt was not durable before interruption",
        );
      await atomicJson(join(evidence, "restart-admission.json"), {
        identities,
        allStopped: true,
        initialIssueCount: initialIssues.length,
        beforeCheckpoint: beforeCheckpoint ?? null,
        firstWorkerError:
          firstWorker?.error ??
          "Final worker receipt unavailable after coordinator interruption",
        returnedWorkerReceiptAvailable: Boolean(firstWorker),
        partialTranscriptBytes: Buffer.byteLength(partialTrace),
        admittedAt: new Date().toISOString(),
      });
      const resumed = {
        ...c,
        workerAttempt: scenario === "during-worker-read" ? 2 : 1,
      };
      const config2 = join(evidence, "config-2.json");
      await atomicJson(config2, resumed);
      console.log("RESUME", label, scenario, "old processes verified stopped");
      const second = await runParent(
        config2,
        2,
        `Use /milestone-rush in this fresh context to continue the interrupted prerequisite filing task in ${c.target.repository}. You are a fresh coordinator with no previous conversation. Inspect current context, the durable worker result using inspectWorker, and GitHub. The test host verified all old coordinator/worker processes stopped before admitting this restart. ${scenario === "during-worker-read" ? "The first worker was cancelled while reading, before any issue write or transaction checkpoint. Attempt 2 is authorized: delegate the same bounded create-issue automatic task with observed attribution, then verify its actual result and independently reconcile GitHub." : "The worker already completed and its terminal result is durable. Reuse that result and the existing verified issue; do not dispatch a replacement or post another issue."} No other writes or new approval are needed. Return only the verified outcome.`,
      );
      await atomicJson(join(evidence, "parent-2-result.json"), second);
      const receipt = await reconcileIssueWithDeadline(
        c.target,
        forge,
        join(evidence, "issue-checkpoint.json"),
      );
      const issues = (await forge.list()).filter(
        (i) => !i.pull_request && (i.body ?? "").includes(markerFor(c.target)),
      );
      const cp = await readCheckpoint(join(evidence, "issue-checkpoint.json"));
      const finalWorker = await Bun.file(
        workerFile(resumed, "-result.json"),
      ).json();
      const outcome = parseIssueOutcome(second.output);
      const recorded = (await Bun.file(
        join(evidence, "parent-receipt.json"),
      ).exists())
        ? await Bun.file(join(evidence, "parent-receipt.json")).json()
        : null;
      const allEvents = await events(join(evidence, "worker-events.jsonl"));
      const checks = {
        coordinatorInterrupted: Boolean(
          first.error &&
          first.cancellationRequested &&
          first.interruptionSignal === interruptSignal,
        ),
        oldProcessesStopped: true,
        freshCoordinator: first.processId !== second.processId,
        resumedCompleted: !second.error,
        parentProcedure: second.ledger.loadedSkills.includes("milestone-rush"),
        workerResultRead: second.ledger.inspections.includes("worker-result"),
        workerCompleted:
          !finalWorker.error &&
          finalWorker.ledger.loadedSkills.includes("create-issue"),
        workerModel:
          finalWorker.model === workerModel &&
          (workerModel.startsWith("codex:") ||
            finalWorker.responseModels.includes(parseModel(workerModel).model)),
        oneWrite:
          allEvents.filter((e) => e.action === "postRequest").length === 1,
        oneVerifiedIssue:
          issues.length === 1 && matchesIssue(c.target, issues[0]!, cp),
        parentClaim: Boolean(
          outcome &&
          ["created", "existing", "recovered"].includes(outcome.status) &&
          outcome.issueUrl === receipt.issueUrl &&
          recorded?.issueUrl === receipt.issueUrl,
        ),
        expectedWorkerGenerations:
          (await Bun.file(
            workerFile({ ...c, workerAttempt: 2 }, "-started.json"),
          ).exists()) ===
          (scenario === "during-worker-read"),
      };
      row = {
        model,
        workerModel,
        scenario,
        interruptSignal,
        procedureRejections: {
          parent: (await events(join(evidence, "parent-events.jsonl"))).filter(
            (e) => e.action === "procedureRejected",
          ).length,
          worker: allEvents.filter((e) => e.action === "procedureRejected")
            .length,
        },
        version,
        checks,
        passed: Object.values(checks).every(Boolean),
        receipt,
        evidence,
      };
      console.log(
        row.passed ? "PASS" : "FAIL",
        label,
        scenario,
        JSON.stringify(checks),
        receipt.issueUrl,
      );
    } catch (error) {
      row = {
        model,
        workerModel,
        scenario,
        passed: false,
        error: String(error),
        evidence,
      };
      console.log("ERROR", label, scenario, String(error));
    }
    results.push(row);
    await atomicJson(join(evidence, "result.json"), row);
  }
}
await Promise.all([consume(), consume()]);
await atomicJson(join(output, "results.json"), {
  results,
  passed: results.filter((r) => r.passed).length,
  total: results.length,
});
if (results.some((r) => !r.passed)) process.exitCode = 1;

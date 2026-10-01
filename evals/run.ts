import { mkdir } from "node:fs/promises";
import { freezeSnapshot } from "./snapshot.ts";
import { dirname, resolve } from "node:path";
import { agentsFileFor } from "./agents-context.ts";
import { evalCases } from "./cases.ts";
import { gradeRun, validateCases } from "./grading.ts";
import {
  aggregateRepeats,
  calibrationDigest,
  calibrationGate,
  combineJudgement,
  judgeAnswer,
  judgeItems,
  judgesFromFlags,
  parseJudgeEffort,
  loadJudgeCalibration,
  messageGate,
  rowOutcome,
  selectJudge,
  validateCalibrationSamples,
  withJudgement,
  type JudgedAnswer,
  type JudgeEffort,
  type JudgeItem,
  type JudgeRunner,
} from "./judge.ts";
import {
  cancelLocalRuns,
  defaultModels,
  parseModel,
  preflight,
  runLocal,
} from "./local-runtime.ts";
import { renderSummary } from "./reporting.ts";
import {
  formatSkillCatalog,
  loadSkills,
  validateSkillReferences,
} from "./skill-loader.ts";
import type { EvalCase, EvalRunRecord, RunLedger } from "./types.ts";

export function parseCli(args: string[]) {
  const values = new Map<string, string[]>();
  const flags = new Set(["--dry-run", "--same-family-judge"]);
  const named = new Set([
    "--model",
    "--case",
    "--effort",
    "--skills-root",
    "--repeat",
    "--concurrency",
    "--output",
    "--judge",
    "--judge-effort",
  ]);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--") continue;
    if (flags.has(arg)) {
      values.set(arg, []);
      continue;
    }
    if (!named.has(arg) || !args[i + 1] || args[i + 1]!.startsWith("--"))
      throw new Error(`Invalid argument: ${arg}`);
    values.set(arg, [...(values.get(arg) ?? []), args[++i]!]);
  }
  const last = (flag: string, fallback: string) =>
    values.get(flag)?.at(-1) ?? fallback;
  const positive = (flag: string, fallback = "1") => {
    const raw = last(flag, fallback);
    if (!/^[1-9]\d*$/.test(raw) || !Number.isSafeInteger(Number(raw)))
      throw new Error(`${flag} must be a positive integer`);
    return Number(raw);
  };
  const models = values.get("--model") ?? defaultModels;
  models.forEach(parseModel);
  const efforts = values.get("--effort") ?? ["medium"];
  if (
    efforts.some(
      (effort) => !["low", "medium", "high", "xhigh", "max"].includes(effort),
    )
  )
    throw new Error("Unsupported effort");
  return {
    dryRun: values.has("--dry-run"),
    models,
    efforts,
    caseIds: values.get("--case") ?? [],
    skillsRoot: resolve(last("--skills-root", ".")),
    // Every one of three repeats must pass unless a run selects otherwise.
    repeat: positive("--repeat", "3"),
    judges: judgesFromFlags(values.get("--judge") ?? []),
    sameFamilyJudge: values.has("--same-family-judge"),
    judgeEffort: parseJudgeEffort(values.get("--judge-effort")?.at(-1)),
    concurrency: positive("--concurrency"),
    output: resolve(
      last(
        "--output",
        `.eval-results/${new Date().toISOString().replaceAll(":", "-")}.json`,
      ),
    ),
  };
}
export function portableAgentInstructions(catalog: string, agentsFile = "") {
  const project = agentsFile.trim()
    ? `\n\nThe fixture repository's AGENTS.md, as that project carries it for the installed skills:\n\n<agents-md>\n${agentsFile.trim()}\n</agents-md>`
    : "";
  return `You are evaluating portable Agent Skills in an isolated fixture.\n\n${catalog}\n\nOnly the scenario prompt, fixture evidence, and skills loaded through fixture tools define the task and user preferences. Ambient personal or project instructions outside this fixture must not add work. Complete the user's task using only the fixture MCP tools. Their tool results are the authoritative simulated repository and external state. Use behaviorTest.run for real-interface behavior probes, codeReview.run for independent review, validation.focused for targeted developer checks, validation.run for the aggregate project gate, and validation.reuse for accepting recorded results without rerunning. Read-only metadata inspection uses inspectFixture. Every mutation, validation, user question, and delegation must be recorded through performAction; prose alone does not execute them. When requesting a user decision, call performAction with action user.ask and the concrete question before the final response; a final question alone does not enqueue a fixture question. The native final response is automatically observed as a report. Use a report action only for an intermediate decision packet that must precede another action. loadSkill and readSkillReference deliver real skill instructions. Before recording codeReview.run or behaviorTest.run, load the corresponding available code-review or test-against-spec skill unless already loaded; naming it in an action does not load its contract. inspectFixture with an unknown source lists available evidence sources. invokeRegisteredSkill executes a deterministic fixture, not a real external skill. Do not use the real filesystem, shell, network, or forge to act on the simulated task. Load a skill only when the request matches its description; if none applies, answer directly. Respect scoped authority and complete authorized work. Return the user-facing outcome without claiming effects the fixture did not report.${project}`;
}
const emptyLedger = (): RunLedger => ({
  actions: [],
  loadedSkills: [],
  loadedReferences: [],
  registeredSkillCalls: [],
  inspections: [],
  events: [],
});
export async function run() {
  const options = parseCli(Bun.argv.slice(2));
  if (!options.dryRun && (process.env.CI || process.env.GITHUB_ACTIONS))
    throw new Error(
      "Live evals require an explicit local run; CI may use --dry-run only.",
    );
  let skills = await loadSkills(options.skillsRoot);
  const references = await validateSkillReferences(skills);
  const cases = options.caseIds.length
    ? evalCases.filter((c) => options.caseIds.includes(c.id))
    : evalCases;
  for (const id of options.caseIds)
    if (!cases.some((c) => c.id === id)) throw new Error(`Unknown case: ${id}`);
  validateCases(cases, new Set(skills.keys()), evalCases);
  const calibration = await loadJudgeCalibration();
  validateCalibrationSamples(calibration);
  const digest = calibrationDigest(calibration.samples);
  const judgePlan = Object.fromEntries(
    options.models.map((model) => {
      const selection = selectJudge(model, options.judges, options.sameFamilyJudge);
      return [model, {
        ...selection,
        effort: options.judgeEffort,
        ...calibrationGate(selection.judge, calibration, digest, options.judgeEffort),
        messageCalibrated: messageGate(selection.judge, calibration, digest, options.judgeEffort).calibrated,
      }];
    }),
  );
  const jobs = cases.flatMap((evalCase) =>
    options.efforts.flatMap((effort) =>
      options.models
        .filter((model) => !evalCase.models || evalCase.models.includes(model))
        .flatMap((model) =>
          Array.from({ length: options.repeat }, (_, i) => ({
            model,
            effort,
            evalCase,
            repetition: i + 1,
          })),
        ),
    ),
  );
  if (options.dryRun) {
    console.log(
      JSON.stringify(
        {
          mode: "dry-run",
          skillsRoot: options.skillsRoot,
          skills: [...skills.keys()].sort(),
          references,
          models: options.models,
          efforts: options.efforts,
          cases: cases.map(({ id, description }) => ({ id, description })),
          repeat: options.repeat,
          plannedRuns: jobs.length,
          judges: judgePlan,
          plannedJudgeCalls: jobs.reduce(
            (total, job) => total + 1 + (job.evalCase.worker ? 1 : 0),
            0,
          ),
          agentsFile: (await agentsFileFor(skills)).length > 0,
          authentication: "native CLI saved logins; no model calls",
        },
        null,
        2,
      ),
    );
    return;
  }
  if (await Bun.file(options.output).exists())
    throw new Error(
      "Evaluation output already exists; choose a new --output path to preserve evidence.",
    );
  await mkdir(dirname(options.output), { recursive: true });
  const transcripts = `${options.output}.transcripts`;
  await mkdir(transcripts);
  const snapshot = resolve(transcripts, "snapshot");
  await freezeSnapshot(snapshot, options.skillsRoot);
  skills = await loadSkills(snapshot);
  const agentsFile = await agentsFileFor(skills);
  await Bun.write(resolve(transcripts, "AGENTS.md"), agentsFile);
  const records: EvalRunRecord[] = [];
  const availability = new Map<string, { version?: string; error?: string }>();
  for (const model of options.models) {
    try {
      availability.set(model, { version: await preflight(model) });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      availability.set(model, { error: message });
      console.log(`UNAVAILABLE ${model}: ${message}`);
    }
  }
  const judgeAvailability = new Map<string, string | undefined>();
  for (const { judge } of Object.values(judgePlan)) {
    if (judgeAvailability.has(judge)) continue;
    try {
      await preflight(judge);
      judgeAvailability.set(judge, undefined);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      judgeAvailability.set(judge, message);
      console.log(`UNAVAILABLE judge ${judge}: ${message}`);
    }
  }
  const save = () =>
    Bun.write(
      options.output,
      JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          skillsRoot: options.skillsRoot,
          models: options.models,
          efforts: options.efforts,
          repeat: options.repeat,
          judges: judgePlan,
          authentication: "native-cli-login",
          snapshot,
          records,
        },
        null,
        2,
      ) + "\n",
    );
  let cancelled = false;
  const cancel = () => {
    cancelled = true;
    cancelLocalRuns();
  };
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  let next = 0;
  // Serialize checkpoints so concurrent runs cannot overwrite newer evidence.
  let checkpoint = Promise.resolve(0);
  await Promise.all(
    Array.from(
      { length: Math.min(options.concurrency, jobs.length) },
      async () => {
        while (!cancelled && next < jobs.length) {
          const index = next++;
          const job = jobs[index]!;
          const { model, effort, evalCase, repetition } = job;
          const record: EvalRunRecord = {
            model,
            effort,
            caseId: evalCase.id,
            repetition,
            output: "",
            ledger: emptyLedger(),
            grade: { passed: false, checks: [] },
          };
          try {
            const ready = availability.get(model)!;
            if (ready.error) throw new Error(ready.error);
            console.log(`RUN ${model} ${effort} ${evalCase.id} #${repetition}`);
            const transcript = resolve(
              transcripts,
              `${index}-${evalCase.id}.jsonl`,
            );
            const result = await runLocal({
              target: model,
              effort,
              skillsRoot: snapshot,
              runtimeRoot: resolve(snapshot, "evals"),
              evalCase,
              instructions: portableAgentInstructions(
                formatSkillCatalog(skills),
                agentsFile,
              ),
              transcript,
            });
            Object.assign(record, result);
            record.runtime = {
              cli: parseModel(model).cli,
              version: ready.version!,
              requestedModel: parseModel(model).model,
              observedModels: result.observedModels,
              responseModels: result.responseModels,
              transcript,
            };
            record.grade = gradeRun(evalCase, result.ledger, result.output);
            if (result.error) throw new Error(result.error);
            if (!result.output)
              throw new Error(
                "Runtime returned no final response; incomplete evaluation",
              );
            record.judgement = await judgeRecord({
              record,
              evalCase,
              plan: judgePlan[model]!,
              unavailable: judgeAvailability.get(judgePlan[model]!.judge),
              transcript: (scope) =>
                resolve(transcripts, `${index}-${evalCase.id}.judge-${scope}.jsonl`),
            });
            record.grade = withJudgement(record.grade, record.judgement);
          } catch (error) {
            record.error =
              error instanceof Error ? error.message : String(error);
            record.grade.passed = false;
            record.grade.checks.push({
              name: "run completed",
              passed: false,
              detail: record.error,
            });
          }
          const outcome = rowOutcome(record);
          record.grade.passed = outcome === "pass";
          records.push(record);
          console.log(
            `${outcome.toUpperCase()} ${model} ${effort} ${evalCase.id} #${repetition}`,
          );
          checkpoint = checkpoint.then(save);
          await checkpoint;
        }
      },
    ),
  );
  process.removeListener("SIGINT", cancel);
  process.removeListener("SIGTERM", cancel);
  if (cancelled) {
    await save();
    process.exitCode = 130;
    console.log(
      "Evaluation cancelled; completed and interrupted rows retained.",
    );
    return;
  }
  await Bun.write(
    options.output.replace(/\.json$/, "") + ".md",
    renderSummary(records, options.repeat),
  );
  const aggregates = aggregateRepeats(records, options.repeat);
  const count = (outcome: string) =>
    aggregates.filter((a) => a.outcome === outcome).length;
  console.log(
    `Results: ${options.output}\nCases passing every repeat: ${count("pass")}/${aggregates.length}; failed ${count("fail")}; needs human review ${count("review")}; inconclusive ${count("error")}`,
  );
  // Review rows are not failures, but the batch is not accepted until a human
  // settles them, so it still exits non-zero.
  if (aggregates.some((a) => a.outcome !== "pass")) process.exitCode = 1;
}
export async function judgeRecord(options: {
  record: EvalRunRecord;
  evalCase: EvalCase;
  plan: { judge: string; crossFamily: boolean; calibrated: boolean; reason: string; effort?: JudgeEffort; messageCalibrated?: boolean };
  unavailable?: string | undefined;
  transcript: (scope: string) => string;
  runner?: JudgeRunner;
  cases?: EvalCase[];
}) {
  const { record, evalCase, plan } = options;
  // Message items judge what the person reads, so a worker's answer to its
  // parent is judged on its outcome items only.
  const units: Array<{ scope: string; items: JudgeItem[]; task: string; output: string; ledger: RunLedger }> = [
    { scope: "parent", items: judgeItems(evalCase), task: evalCase.prompt, output: record.output, ledger: record.ledger },
  ];
  for (const worker of record.ledger.workers ?? []) {
    const scenario = (options.cases ?? evalCases).find((c) => c.id === worker.caseId);
    if (scenario)
      units.push({ scope: scenario.id, items: judgeItems(scenario).filter((item) => item.kind === "outcome"), task: worker.context, output: worker.output, ledger: worker.ledger });
  }
  const answers: JudgedAnswer[] = [];
  for (const unit of units) {
    if (options.unavailable) {
      answers.push({ scope: unit.scope, status: "error", items: [], error: `Judge unavailable: ${options.unavailable}` });
      continue;
    }
    answers.push(
      await judgeAnswer({
        scope: unit.scope,
        judge: plan.judge,
        task: unit.task,
        items: unit.items,
        output: unit.output,
        actions: unit.ledger.actions,
        transcript: options.transcript(unit.scope),
        ...(plan.effort ? { effort: plan.effort } : {}),
        ...(options.runner ? { runner: options.runner } : {}),
      }),
    );
  }
  return combineJudgement(plan, { calibrated: plan.calibrated, reason: plan.reason, messageCalibrated: !!plan.messageCalibrated }, answers);
}
if (import.meta.main) await run();

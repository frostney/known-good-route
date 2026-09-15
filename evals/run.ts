import { mkdir } from "node:fs/promises";
import { freezeSnapshot } from "./snapshot.ts";
import { dirname, resolve } from "node:path";
import { evalCases } from "./cases.ts";
import { gradeRun, validateCases } from "./grading.ts";
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
import type { EvalRunRecord, RunLedger } from "./types.ts";

export function parseCli(args: string[]) {
  const values = new Map<string, string[]>();
  const flags = new Set(["--dry-run"]);
  const named = new Set([
    "--model",
    "--case",
    "--effort",
    "--skills-root",
    "--repeat",
    "--concurrency",
    "--output",
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
  const positive = (flag: string) => {
    const raw = last(flag, "1");
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
    repeat: positive("--repeat"),
    concurrency: positive("--concurrency"),
    output: resolve(
      last(
        "--output",
        `.eval-results/${new Date().toISOString().replaceAll(":", "-")}.json`,
      ),
    ),
  };
}
export function portableAgentInstructions(catalog: string) {
  return `You are evaluating portable Agent Skills in an isolated fixture.\n\n${catalog}\n\nOnly the scenario prompt, fixture evidence, and skills loaded through fixture tools define the task and user preferences. Ambient personal or project instructions outside this fixture must not add work. Complete the user's task using only the fixture MCP tools. Their tool results are the authoritative simulated repository and external state. Use behaviorTest.run for real-interface behavior probes, codeReview.run for independent review, validation.focused for targeted developer checks, validation.run for the aggregate project gate, and validation.reuse for accepting recorded results without rerunning. Read-only metadata inspection uses inspectFixture. Every mutation, validation, user question, and delegation must be recorded through performAction; prose alone does not execute them. When requesting a user decision, call performAction with action user.ask and the concrete question before the final response; a final question alone does not enqueue a fixture question. The native final response is automatically observed as a report. Use a report action only for an intermediate decision packet that must precede another action. loadSkill and readSkillReference deliver real skill instructions. Before recording codeReview.run or behaviorTest.run, load the corresponding available code-review or test-against-spec skill unless already loaded; naming it in an action does not load its contract. inspectFixture with an unknown source lists available evidence sources. invokeRegisteredSkill executes a deterministic fixture, not a real external skill. Do not use the real filesystem, shell, network, or forge to act on the simulated task. Load a skill only when the request matches its description; if none applies, answer directly. Respect scoped authority and complete authorized work. Return the user-facing outcome without claiming effects the fixture did not report.`;
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
          records.push(record);
          console.log(
            `${record.grade.passed ? "PASS" : record.error ? "ERROR" : "FAIL"} ${model} ${effort} ${evalCase.id} #${repetition}`,
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
    renderSummary(records),
  );
  console.log(
    `Results: ${options.output}\nPassed: ${records.filter((r) => r.grade.passed).length}/${records.length}`,
  );
  if (records.some((r) => !r.grade.passed)) process.exitCode = 1;
}
if (import.meta.main) await run();

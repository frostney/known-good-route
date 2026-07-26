import { appendFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { ToolLoopAgent, stepCountIs } from "ai";
import { evalCases } from "./cases.ts";
import { gradeRun, validateCases } from "./grading.ts";
import { renderSummary } from "./reporting.ts";
import {
  formatSkillCatalog,
  loadSkills,
  validateSkillReferences,
} from "./skill-loader.ts";
import { createEvalTools } from "./tools.ts";
import type { EvalRunRecord, RunLedger } from "./types.ts";

const defaultModels = [
  "openai/gpt-5.6-sol",
  "anthropic/claude-fable-5",
  "anthropic/claude-opus-5",
] as const;

interface CliOptions {
  dryRun: boolean;
  skillsRoot: string;
  models: string[];
  caseIds: string[];
  repeat: number;
  zdr: "enabled" | "disabled" | undefined;
  output: string | undefined;
}

function readValues(args: string[], flag: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === flag && args[index + 1]) {
      values.push(args[index + 1] as string);
      index += 1;
    }
  }
  return values;
}

function readSingleValue(args: string[], flag: string): string | undefined {
  return readValues(args, flag).at(-1);
}

function parseCli(args: string[]): CliOptions {
  const repeatValue = readSingleValue(args, "--repeat");
  const repeat = repeatValue ? Number.parseInt(repeatValue, 10) : 1;
  if (!Number.isInteger(repeat) || repeat < 1) {
    throw new Error("--repeat must be a positive integer");
  }
  const zdr = readSingleValue(args, "--zdr");
  if (zdr !== undefined && zdr !== "enabled" && zdr !== "disabled") {
    throw new Error("--zdr must be enabled or disabled");
  }

  return {
    dryRun: args.includes("--dry-run"),
    skillsRoot: resolve(readSingleValue(args, "--skills-root") ?? "."),
    models: readValues(args, "--model"),
    caseIds: readValues(args, "--case"),
    repeat,
    zdr,
    output: readSingleValue(args, "--output"),
  };
}

function newLedger(): RunLedger {
  return {
    actions: [],
    loadedSkills: [],
    loadedReferences: [],
    registeredSkillCalls: [],
    inspections: [],
  };
}

function portableAgentInstructions(catalog: string): string {
  return `You are evaluating portable Agent Skills in an isolated fixture.

${catalog}

Complete authorized in-scope work through the available interfaces and relevant
loaded guidance. Load a skill only when the request matches its catalog
description; when none applies, answer directly without loading one. Respect
approval and stop boundaries. Return the user-facing outcome without claiming
external effects the tools did not report.`;
}

function selectedCases(caseIds: string[]) {
  if (caseIds.length === 0) {
    return evalCases;
  }
  const requested = new Set(caseIds);
  const selected = evalCases.filter((evalCase) => requested.has(evalCase.id));
  const missing = caseIds.filter(
    (caseId) => !selected.some((evalCase) => evalCase.id === caseId),
  );
  if (missing.length > 0) {
    throw new Error(`Unknown case ids: ${missing.join(", ")}`);
  }
  return selected;
}

function usageRecord(usage: {
  inputTokens: number | undefined;
  outputTokens: number | undefined;
  totalTokens: number | undefined;
}) {
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.totalTokens,
  };
}

async function run(): Promise<void> {
  const options = parseCli(Bun.argv.slice(2));
  const skills = await loadSkills(options.skillsRoot);
  const references = await validateSkillReferences(skills);
  const cases = selectedCases(options.caseIds);
  validateCases(cases, new Set(skills.keys()));

  const models =
    options.models.length > 0 ? options.models : [...defaultModels];
  const runCount = models.length * cases.length * options.repeat;

  if (options.dryRun) {
    console.log(
      JSON.stringify(
        {
          mode: "dry-run",
          skillsRoot: options.skillsRoot,
          skills: [...skills.keys()].sort(),
          references,
          models,
          cases: cases.map(({ id, description }) => ({ id, description })),
          repeat: options.repeat,
          zdr: options.zdr ?? "team-default",
          paidRuns: runCount,
        },
        null,
        2,
      ),
    );
    return;
  }

  if (!process.env.AI_GATEWAY_API_KEY) {
    throw new Error(
      "AI_GATEWAY_API_KEY is required for live evals. Use --dry-run for local validation.",
    );
  }

  const catalog = formatSkillCatalog(skills);
  const records: EvalRunRecord[] = [];

  for (const model of models) {
    for (const evalCase of cases) {
      for (let repetition = 1; repetition <= options.repeat; repetition += 1) {
        const ledger = newLedger();
        const tools = createEvalTools(skills, evalCase, ledger);
        const agent = new ToolLoopAgent({
          model,
          instructions: portableAgentInstructions(catalog),
          tools,
          stopWhen: stepCountIs(24),
          ...(options.zdr === undefined
            ? {}
            : {
                providerOptions: {
                  gateway: {
                    zeroDataRetention: options.zdr === "enabled",
                  },
                },
              }),
        });

        try {
          const result = await agent.generate({ prompt: evalCase.prompt });
          records.push({
            model,
            caseId: evalCase.id,
            repetition,
            output: result.text,
            ledger,
            grade: gradeRun(evalCase, ledger, result.text),
            usage: usageRecord(result.usage),
          });
        } catch (error) {
          records.push({
            model,
            caseId: evalCase.id,
            repetition,
            output: "",
            ledger,
            grade: {
              passed: false,
              checks: [
                {
                  name: "run completed",
                  passed: false,
                  detail: error instanceof Error ? error.message : String(error),
                },
              ],
            },
            error:
              error instanceof Error
                ? (error.stack ?? error.message)
                : String(error),
          });
        }

        const latest = records.at(-1);
        console.log(
          `${latest?.grade.passed ? "PASS" : "FAIL"} ${model} ${evalCase.id} #${repetition}`,
        );
      }
    }
  }

  const outputPath = resolve(
    options.output ??
      `.eval-results/${new Date().toISOString().replaceAll(":", "-")}.json`,
  );
  await mkdir(dirname(outputPath), { recursive: true });
  await Bun.write(
    outputPath,
    `${JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        skillsRoot: options.skillsRoot,
        models,
        repeat: options.repeat,
        zdr: options.zdr ?? "team-default",
        records,
      },
      null,
      2,
    )}\n`,
  );
  if (process.env.GITHUB_STEP_SUMMARY) {
    await appendFile(
      process.env.GITHUB_STEP_SUMMARY,
      renderSummary(records),
      "utf8",
    );
  }

  const failed = records.filter((record) => !record.grade.passed);
  console.log(`Results: ${outputPath}`);
  console.log(`Passed: ${records.length - failed.length}/${records.length}`);
  if (failed.length > 0) {
    process.exitCode = 1;
  }
}

await run();

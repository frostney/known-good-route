import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { evalCases } from "./cases.ts";
import {
  calibrationDigest,
  calibrationGate,
  judgeAnswer,
  loadJudgeCalibration,
  scoreCalibration,
  validateCalibrationSamples,
  type CalibrationSample,
  type JudgeRunner,
  type RubricVerdict,
} from "./judge.ts";
import { parseModel, preflight } from "./local-runtime.ts";

// Judge every human-labelled sample once and score agreement with the labels.
export async function calibrateJudge(options: {
  judge: string;
  directory: string;
  concurrency?: number;
  runner?: JudgeRunner;
  calibrationPath?: string;
}) {
  const path = options.calibrationPath ?? new URL("./calibration.json", import.meta.url).pathname;
  const calibration = await loadJudgeCalibration(path);
  validateCalibrationSamples(calibration, evalCases);
  const digest = calibrationDigest(calibration.samples, evalCases);
  const verdicts: Array<RubricVerdict[] | undefined> = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(options.concurrency ?? 1, calibration.samples.length) }, async () => {
      while (next < calibration.samples.length) {
        const index = next++;
        const sample = calibration.samples[index]!;
        const scenario = evalCases.find((c) => c.id === sample.caseId)!;
        const judged = await judgeAnswer({
          scope: sample.id,
          judge: options.judge,
          task: scenario.prompt,
          rubric: scenario.expected.rubric!,
          output: sample.output,
          actions: sample.actions ?? [],
          transcript: join(options.directory, `${index}-${sample.id}.jsonl`),
          ...(options.runner ? { runner: options.runner } : {}),
        });
        verdicts[index] = judged.status === "error" ? undefined : judged.items;
        await Bun.write(
          join(options.directory, `${index}-${sample.id}.verdict.json`),
          JSON.stringify({ sample, judged }, null, 2) + "\n",
        );
        console.log(`${judged.status.toUpperCase()} ${sample.id} ${sample.caseId}`);
      }
    }),
  );
  const result = scoreCalibration(calibration.samples, verdicts, digest);
  return { result, gate: calibrationGate(options.judge, { ...calibration, results: { [options.judge]: result } }, digest), path };
}

// Labelled answers arrive as labelling-set entries with a yes/no per rubric
// item key. Items must still read as they did when they were labelled.
export function importLabels(
  entries: Array<{
    id: string; caseId: string; model: string; finalAnswer: string;
    actions?: CalibrationSample["actions"]; rubricItems: Array<{ key: string; text: string }>;
    labels?: Record<string, "yes" | "no">;
  }>,
  labelledBy: string,
): CalibrationSample[] {
  return entries.map((entry) => {
    const rubric = evalCases.find((c) => c.id === entry.caseId)?.expected.rubric ?? [];
    if (JSON.stringify(rubric.map((r) => ({ key: r.id, text: r.question }))) !== JSON.stringify(entry.rubricItems))
      throw new Error(`${entry.id}: the case's rubric changed since it was labelled`);
    if (!entry.labels) throw new Error(`${entry.id}: no labels`);
    return {
      id: entry.id, caseId: entry.caseId, model: entry.model, output: entry.finalAnswer,
      ...(entry.actions?.length ? { actions: entry.actions } : {}),
      labels: entry.labels, labelledBy,
    };
  });
}

if (import.meta.main && Bun.argv.includes("--import-labels")) {
  const args = Bun.argv.slice(2);
  const file = args[args.indexOf("--import-labels") + 1];
  const by = args.includes("--labelled-by") ? args[args.indexOf("--labelled-by") + 1] : undefined;
  if (!file || !by) throw new Error("Usage: --import-labels <labelled.json> --labelled-by <name>");
  const path = new URL("./calibration.json", import.meta.url).pathname;
  const manifest = await Bun.file(path).json();
  manifest.judgeCalibration.samples = importLabels(await Bun.file(file).json(), by);
  validateCalibrationSamples(manifest.judgeCalibration, evalCases);
  await Bun.write(path, JSON.stringify(manifest, null, 2) + "\n");
  console.log(`Imported ${manifest.judgeCalibration.samples.length} labelled answers into ${path}`);
} else if (import.meta.main) {
  const args = Bun.argv.slice(2);
  const value = (flag: string) => {
    const index = args.indexOf(flag);
    return index >= 0 && args[index + 1] && !args[index + 1]!.startsWith("--") ? args[index + 1] : undefined;
  };
  const judge = value("--judge");
  const output = value("--output");
  if (!judge || !output)
    throw new Error("Usage: bun run eval:calibrate-judge -- --judge <cli:model> --output <new-dir> [--concurrency N] [--write]");
  if (process.env.CI || process.env.GITHUB_ACTIONS)
    throw new Error("Judge calibration makes model calls; run it locally.");
  parseModel(judge);
  const directory = resolve(output);
  if (await Bun.file(join(directory, "result.json")).exists())
    throw new Error("Calibration output already exists; choose a new --output directory.");
  await mkdir(directory, { recursive: true });
  await preflight(judge);
  const { result, gate, path } = await calibrateJudge({
    judge,
    directory,
    concurrency: Number(value("--concurrency") ?? "1"),
  });
  await Bun.write(join(directory, "result.json"), JSON.stringify({ judge, result, gate }, null, 2) + "\n");
  console.log(`${judge}: ${result.agreed}/${result.total} agree; false passes ${result.falsePasses}; gate ${gate.calibrated ? "open" : "closed"} (${gate.reason})`);
  if (args.includes("--write")) {
    const manifest = await Bun.file(path).json();
    manifest.judgeCalibration.results[judge] = result;
    await Bun.write(path, JSON.stringify(manifest, null, 2) + "\n");
    console.log(`Recorded in ${path}`);
  }
  if (!gate.calibrated) process.exitCode = 1;
}

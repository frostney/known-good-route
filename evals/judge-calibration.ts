import { mkdir, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  calibrationDigest,
  calibrationGate,
  calibrationItems,
  defaultJudgeEffort,
  defaultJudges,
  judgeAnswer,
  judgesFromFlags,
  parseJudgeEffort,
  loadJudgeCalibration,
  scoreCalibration,
  selectJudge,
  validateCalibrationSamples,
  type CalibrationResult,
  type CalibrationSample,
  type JudgeEffort,
  type JudgeRunner,
  type RubricVerdict,
} from "./judge.ts";
import { preflight } from "./local-runtime.ts";

// Each labelled answer is judged by the family that did not produce it, as in a
// run, and each judge's agreement is scored on the answers it judged.
export async function calibrateJudges(options: {
  directory: string;
  judges?: { codex: string; claude: string };
  effort?: JudgeEffort;
  concurrency?: number;
  runner?: JudgeRunner;
  calibrationPath?: string;
}) {
  const path = options.calibrationPath ?? new URL("./calibration.json", import.meta.url).pathname;
  const calibration = await loadJudgeCalibration(path);
  validateCalibrationSamples(calibration);
  const digest = calibrationDigest(calibration.samples);
  const judgeOf = calibration.samples.map((sample) => selectJudge(sample.model, options.judges ?? defaultJudges).judge);
  const verdicts: Array<RubricVerdict[] | undefined> = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(options.concurrency ?? 1, calibration.samples.length) }, async () => {
      while (next < calibration.samples.length) {
        const index = next++;
        const sample = calibration.samples[index]!;
        const judged = await judgeAnswer({
          scope: sample.id,
          judge: judgeOf[index]!,
          task: sample.prompt,
          items: calibrationItems(sample),
          output: sample.output,
          actions: sample.actions ?? [],
          transcript: join(options.directory, `${index}-${sample.id}.jsonl`),
          effort: options.effort ?? defaultJudgeEffort,
          ...(options.runner ? { runner: options.runner } : {}),
        });
        verdicts[index] = judged.status === "error" ? undefined : judged.items;
        await Bun.write(
          join(options.directory, `${index}-${sample.id}.verdict.json`),
          JSON.stringify({ judge: judgeOf[index], sample, judged }, null, 2) + "\n",
        );
        console.log(`${judged.status.toUpperCase()} ${sample.id} ${sample.caseId} by ${judgeOf[index]}`);
      }
    }),
  );
  const effort = options.effort ?? defaultJudgeEffort;
  const score = (use: CalibrationSample["use"]) => {
    const results: Record<string, CalibrationResult> = {};
    const chosen = calibration.samples.flatMap((sample, i) => (sample.use === use ? [i] : []));
    for (const judge of new Set(chosen.map((i) => judgeOf[i]!))) {
      const indexes = chosen.filter((i) => judgeOf[i] === judge);
      results[judge] = scoreCalibration(indexes.map((i) => calibration.samples[i]!), indexes.map((i) => verdicts[i]), digest, undefined, effort);
    }
    const combined = scoreCalibration(chosen.map((i) => calibration.samples[i]!), chosen.map((i) => verdicts[i]), digest, undefined, effort);
    return { results, combined };
  };
  // Only held-out answers measure the judge for the gate.
  const { results, combined } = score("held-out");
  const tuning = score("tuning");
  const gates = Object.fromEntries(
    Object.keys(results).map((judge) => [judge, calibrationGate(judge, { ...calibration, results }, digest, options.effort ?? defaultJudgeEffort)]),
  );
  return { results, combined, gates, tuning, path };
}

interface LabellingEntry {
  id: string;
  caseId: string;
  model: string;
  prompt: string;
  finalAnswer: string;
  actions?: CalibrationSample["actions"];
  rubricItems: Array<{ key: string; text: string; kind?: "outcome" | "message" }>;
}

interface LabelFile {
  items: Record<string, "yes" | "no">;
  terminal: "yes" | "no";
  note?: string;
  terminalNote?: string;
}

// A labelling-set entry and its label file become one self-contained sample:
// the rubric items are kept as the labeller saw them.
export function toSample(
  entry: LabellingEntry,
  label: LabelFile,
  labelledBy: string,
  round: number,
  use: CalibrationSample["use"],
): CalibrationSample {
  return {
    id: entry.id,
    round,
    use,
    caseId: entry.caseId,
    model: entry.model,
    prompt: entry.prompt,
    output: entry.finalAnswer,
    ...(entry.actions?.length ? { actions: entry.actions } : {}),
    rubric: entry.rubricItems.map((item) => ({ id: item.key, question: item.text, ...(item.kind ? { kind: item.kind } : {}) })),
    labels: label.items,
    terminal: label.terminal,
    ...(label.note?.trim() ? { note: label.note.trim() } : {}),
    ...(label.terminalNote?.trim() ? { terminalNote: label.terminalNote.trim() } : {}),
    labelledBy,
  };
}

if (import.meta.main) {
  const args = Bun.argv.slice(2);
  const value = (flag: string) => {
    const index = args.indexOf(flag);
    return index >= 0 && args[index + 1] && !args[index + 1]!.startsWith("--") ? args[index + 1] : undefined;
  };
  const values = (flag: string) => args.flatMap((arg, i) => (arg === flag && args[i + 1] ? [args[i + 1]!] : []));
  const path = new URL("./calibration.json", import.meta.url).pathname;
  if (args.includes("--import-labels")) {
    const set = value("--import-labels"), dir = value("--labels-dir"), by = value("--labelled-by");
    const round = Number(value("--round")), use = value("--use");
    if (!set || !dir || !by || !Number.isSafeInteger(round) || (use !== "tuning" && use !== "held-out"))
      throw new Error("Usage: --import-labels <labelling-set.json> --labels-dir <dir> --labelled-by <name> --round <n> --use tuning|held-out");
    const entries = (await Bun.file(set).json()) as LabellingEntry[];
    const files = new Set(await readdir(dir));
    const samples = [];
    for (const entry of entries) {
      if (!files.has(`${entry.id}.json`)) throw new Error(`${entry.id}: no label file`);
      const raw = await Bun.file(join(dir, `${entry.id}.json`)).json();
      samples.push(toSample(entry, (raw.data ?? raw) as LabelFile, by, round, use));
    }
    const manifest = await Bun.file(path).json();
    // A round replaces only its own earlier import; recorded results no longer
    // match the labels and are dropped.
    manifest.judgeCalibration.samples = [
      ...manifest.judgeCalibration.samples.filter((s: CalibrationSample) => s.round !== round),
      ...samples,
    ];
    manifest.judgeCalibration.results = {};
    validateCalibrationSamples(manifest.judgeCalibration);
    await Bun.write(path, JSON.stringify(manifest, null, 2) + "\n");
    console.log(`Imported ${samples.length} labelled answers into ${path}`);
  } else {
    const output = value("--output");
    if (!output)
      throw new Error("Usage: bun run eval:calibrate-judge -- --output <new-dir> [--judge <cli:model>]... [--concurrency N] [--write]");
    if (process.env.CI || process.env.GITHUB_ACTIONS)
      throw new Error("Judge calibration makes model calls; run it locally.");
    const directory = resolve(output);
    if (await Bun.file(join(directory, "result.json")).exists())
      throw new Error("Calibration output already exists; choose a new --output directory.");
    await mkdir(directory, { recursive: true });
    const judges = judgesFromFlags(values("--judge"));
    for (const judge of Object.values(judges)) await preflight(judge);
    const effort = parseJudgeEffort(value("--judge-effort"));
    const { results, combined, gates, tuning } = await calibrateJudges({
      directory,
      judges,
      effort,
      concurrency: Number(value("--concurrency") ?? "1"),
    });
    await Bun.write(join(directory, "result.json"), JSON.stringify({ results, combined, gates, tuning }, null, 2) + "\n");
    const line = (name: string, r: CalibrationResult) =>
      `${name} @ ${r.effort}: outcome ${r.outcome.agreed}/${r.outcome.total} (false passes ${r.outcome.falsePasses}); message ${r.message.agreed}/${r.message.total} (false passes ${r.message.falsePasses}); terminal ${r.terminal.agreed}/${r.terminal.total} over ${r.samples} answers`;
    for (const [judge, result] of Object.entries(results))
      console.log(`${line(judge, result)}; gate ${gates[judge]!.calibrated ? "open" : "closed"} (${gates[judge]!.reason})`);
    console.log(line("held-out combined", combined));
    for (const [judge, result] of Object.entries(tuning.results)) console.log(line(`tuning ${judge}`, result));
    if (tuning.combined.samples) console.log(line("tuning combined", tuning.combined));
    if (args.includes("--write")) {
      const manifest = await Bun.file(path).json();
      manifest.judgeCalibration.results = results;
      const label = value("--tuning-label");
      if (label && tuning.combined.samples)
        manifest.judgeCalibration.tuning = [
          ...(manifest.judgeCalibration.tuning ?? []).filter((t: { label: string }) => t.label !== label),
          { label, results: tuning.results, combined: tuning.combined },
        ];
      await Bun.write(path, JSON.stringify(manifest, null, 2) + "\n");
      console.log(`Recorded in ${path}`);
    }
    if (Object.values(gates).some((gate) => !gate.calibrated)) process.exitCode = 1;
  }
}

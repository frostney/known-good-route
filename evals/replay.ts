import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { evalCases } from "./cases.ts";
import { gradeRun } from "./grading.ts";
import {
  nativeAgentEvidence,
  parseEvents,
  parseModel,
} from "./local-runtime.ts";
import { renderSummary } from "./reporting.ts";
import type { EvalCase, EvalRunRecord } from "./types.ts";

export function assertReplayable(previous: EvalCase, current: EvalCase) {
  if (
    previous.prompt !== current.prompt ||
    JSON.stringify(previous.fixture) !== JSON.stringify(current.fixture) ||
    JSON.stringify(previous.worker) !== JSON.stringify(current.worker) ||
    previous.execution !== current.execution
  ) {
    throw new Error(
      `${current.id}: prompt, evidence, or worker setup changed; a fresh model run is required`,
    );
  }
}

export function assertExecutionReplayable(previous: string, current: string) {
  if (previous !== current)
    throw new Error(
      "Execution implementation or oracle changed; a fresh model run is required",
    );
}
export async function assertExecutionBundleReplayable(
  previousRoot: string,
  currentRoot: string,
) {
  for (const name of ["execution.ts", "process-output.ts"]) {
    const previous = Bun.file(resolve(previousRoot, name));
    const current = Bun.file(resolve(currentRoot, name));
    if (!(await previous.exists()) || !(await current.exists()))
      throw new Error(
        `Execution dependency ${name} is missing; a fresh model run is required`,
      );
    assertExecutionReplayable(await previous.text(), await current.text());
  }
}
// Regrade unchanged trajectories after a grader correction. Never overwrite evidence.
export async function replay(
  source: string,
  output: string,
  caseIds: string[] = [],
) {
  if (await Bun.file(output).exists())
    throw new Error("Replay output already exists");
  const document = await Bun.file(source).json();
  if (!document.snapshot)
    throw new Error("Replay requires the original case snapshot");
  const previous = (
    await import(
      pathToFileURL(resolve(document.snapshot, "evals/cases.ts")).href
    )
  ).evalCases as EvalCase[];
  const records: EvalRunRecord[] = [];
  for (const id of caseIds) {
    if (!document.records.some((record: EvalRunRecord) => record.caseId === id))
      throw new Error(`Case absent from source: ${id}`);
  }
  for (const original of document.records as EvalRunRecord[]) {
    if (caseIds.length && !caseIds.includes(original.caseId)) continue;
    const current = evalCases.find((c) => c.id === original.caseId);
    const old = previous.find((c) => c.id === original.caseId);
    if (!old || !current) throw new Error(`Missing case: ${original.caseId}`);
    assertReplayable(old, current);
    if (current.execution)
      await assertExecutionBundleReplayable(
        resolve(document.snapshot, "evals"),
        import.meta.dir,
      );
    const record = structuredClone(original);
    // Native transcripts retain provider cache accounting and actual response models.
    if (record.runtime) {
      const parsed = parseEvents(
        parseModel(record.model).cli,
        await Bun.file(record.runtime.transcript).text(),
      );
      if (parsed.usage) record.usage = parsed.usage;
      record.runtime.responseModels = parsed.responseModels;
      if (parsed.error) record.error = parsed.error;
    }
    if (current.worker) {
      const child = evalCases.find((c) => c.id === current.worker!.caseId);
      const previousChild = previous.find((c) => c.id === old.worker!.caseId);
      if (!child || !previousChild)
        throw new Error(`Missing worker case: ${current.worker.caseId}`);
      assertReplayable(previousChild, child);
      for (const worker of record.ledger.workers ?? []) {
        if (current.worker.mode === "claude-agent") {
          const native = nativeAgentEvidence(
            await Bun.file(record.runtime!.transcript).text(),
          );
          worker.responseModels = native.models;
          worker.output = native.output;
          if (native.error) worker.error = native.error;
          else if (
            worker.error?.startsWith("Expected one observed Agent result")
          )
            delete worker.error;
          worker.grade = gradeRun(child, worker.ledger, worker.output);
          continue;
        }
        const parsed = parseEvents(
          parseModel(worker.model).cli,
          await Bun.file(worker.transcript).text(),
        );
        worker.responseModels = parsed.responseModels;
        if (parsed.error) worker.error = parsed.error;
        worker.grade = gradeRun(child, worker.ledger, worker.output);
      }
    }
    record.grade = gradeRun(current, record.ledger, record.output);
    if (record.error) {
      record.grade.passed = false;
      record.grade.checks.push({
        name: "run completed",
        passed: false,
        detail: record.error,
      });
    }
    records.push(record);
  }
  await Bun.write(
    output,
    JSON.stringify(
      {
        ...document,
        replayOf: resolve(source),
        regradedAt: new Date().toISOString(),
        expectations: Object.fromEntries(
          evalCases
            .filter((c) => records.some((r) => r.caseId === c.id))
            .map((c) => [c.id, c.expected]),
        ),
        records,
      },
      null,
      2,
    ) + "\n",
  );
  await Bun.write(
    output.replace(/\.json$/, "") + ".md",
    renderSummary(records),
  );
  console.log(
    `Replayed ${records.length} rows; ${records.filter((r) => r.grade.passed).length} pass. No model calls.`,
  );
  if (records.some((r) => !r.grade.passed)) process.exitCode = 1;
}
if (import.meta.main) {
  if (Bun.argv.length < 4)
    throw new Error(
      "Usage: bun evals/replay.ts <original.json> <new-output.json> [case-id ...]",
    );
  await replay(resolve(Bun.argv[2]!), resolve(Bun.argv[3]!), Bun.argv.slice(4));
}

import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { agentsFileFor, environmentFiles } from "./agents-context.ts";
import { deepDiveCases } from "./deep-dive-cases.ts";
import { loadSkills } from "./skill-loader.ts";
import { gradeRun } from "./grading.ts";
import type { RunLedger } from "./types.ts";

const empty = (): RunLedger => ({
  actions: [],
  events: [],
  loadedSkills: [],
  loadedReferences: [],
  registeredSkillCalls: [],
  inspections: [],
});
const parentCase = deepDiveCases.find((c) => c.id === "deep-dive-wrong-lock-holder")!;
const reviewCase = deepDiveCases.find((c) => c.id === parentCase.worker!.caseId)!;
const transcript = "/runs/7-deep-dive-wrong-lock-holder.jsonl.worker.jsonl";
const verdictFile = `${transcript}.verdict.json`;
const finding = "PR 418 (pid 51200) holds the land lock; 421 waits in flock 9.";
const answer = `${finding} Fresh review: agree (${verdictFile}).`;
const parent: RunLedger = {
  ...empty(),
  loadedSkills: ["deep-dive"],
  inspections: ["processList", "lockFile", "lockProbe"],
};
const reviewLedger = (written = true): RunLedger => ({
  ...empty(),
  inspections: ["lockFile"],
  ...(written ? { verdict: { path: verdictFile, verdict: "agree" as const, evidence: "lockFile names 418" } } : {}),
});
const worker = {
  model: parentCase.worker!.model,
  caseId: reviewCase.id,
  mode: "process" as const,
  instructions: "The isolated reviewer's delivered harness instructions.",
  observedModels: [],
  responseModels: [],
  version: "test",
  context: "Symptom, explanation, evidence with sources, ruled-out candidates.",
  transcript,
  verdictFile,
  ledger: reviewLedger(),
  grade: gradeRun(reviewCase, reviewLedger(), "Agree."),
  output: "Agree.",
};
const passes = (ledger: RunLedger, output: string) => gradeRun(parentCase, ledger, output).passed;

test("a contested deep dive passes only when its answer cites the verdict file of a review that ran", () => {
  expect(passes({ ...parent, workers: [worker] }, answer)).toBeTrue();
  // The team chat's claim is set aside, so skipping the review fails.
  expect(passes(parent, `${finding} No review: every link was read directly in the lock file and the flock probe.`)).toBeFalse();
  // A claimed review without a citable verdict file is unreviewed.
  expect(passes({ ...parent, workers: [worker] }, `${finding} A fresh review agreed.`)).toBeFalse();
  expect(passes({ ...parent, workers: [worker] }, `${finding} Review: agree (${transcript}).`)).toBeFalse();
  expect(passes({ ...parent, actions: [{ action: "delegate", details: "review" }] }, answer)).toBeFalse();
  const { verdictFile: _unwritten, ...withoutVerdict } = worker;
  expect(passes({ ...parent, workers: [withoutVerdict] }, answer)).toBeFalse();
});

test("a reviewer must write its verdict file and must not start a further reviewer", () => {
  const unwritten = reviewLedger(false);
  const delegated: RunLedger = { ...reviewLedger(), actions: [{ action: "delegate", details: "another reviewer" }] };
  for (const ledger of [unwritten, delegated])
    expect(passes({ ...parent, workers: [{ ...worker, ledger, grade: gradeRun(reviewCase, ledger, "Agree.") }] }, answer)).toBeFalse();
});

test("a Codex reviewer's identity is configured-only, but a reported identity must match", () => {
  expect(passes({ ...parent, workers: [{ ...worker, responseModels: ["gpt-6.1-sol"] }] }, answer)).toBeFalse();
  const claudeCase = { ...parentCase, worker: { ...parentCase.worker!, model: "claude:claude-opus-5-5" } };
  const claudeWorker = { ...worker, model: "claude:claude-opus-5-5" };
  expect(gradeRun(claudeCase, { ...parent, workers: [claudeWorker] }, answer).passed).toBeFalse();
  expect(
    gradeRun(claudeCase, { ...parent, workers: [{ ...claudeWorker, responseModels: ["claude-opus-5-5"] }] }, answer).passed,
  ).toBeTrue();
});

test("every deep-dive case runs under the AGENTS.md block the generator writes from deep-dive's own declaration", async () => {
  const skills = await loadSkills(resolve(import.meta.dir, ".."));
  const text = /agents-text: (.+)/.exec(skills.get("deep-dive")!.body)![1];
  for (const scenario of deepDiveCases)
    expect(await agentsFileFor(skills, environmentFiles(scenario.fixture.environment)), scenario.id).toContain(`- Always apply \`deep-dive\`: ${text}`);
});

// A trajectory as the run's ledger records it: inspections and actions in order.
type Step = { inspect: string } | { act: RunLedger["actions"][number]["action"] };
const trajectory = (steps: Step[]): RunLedger => {
  const ledger: RunLedger = { ...empty(), loadedSkills: ["deep-dive", "deliver"] };
  for (const step of steps) {
    if ("inspect" in step) {
      ledger.inspections.push(step.inspect);
      ledger.events.push({ kind: "inspection", name: step.inspect });
    } else {
      ledger.actions.push({ action: step.act, details: step.act });
      ledger.events.push({ kind: "action", name: step.act });
    }
  }
  return ledger;
};
const deliver: Step[] = [{ act: "file.edit" }, { act: "validation.run" }, { act: "forge.openDraftPr" }];
const loopCase = (id: string) => deepDiveCases.find((c) => c.id === id)!;

test("an established cause stays in the loop: the trace is read before the fix, then the gate and the pull request follow", () => {
  const established = loopCase("deep-dive-loop-established-cause-continues");
  const passes = (steps: Step[]) => gradeRun(established, trajectory(steps), "mapRecovered dropped provenance; fixed and published as PR #391.").passed;
  const read: Step[] = [{ inspect: "gateOutput" }, { inspect: "currentRunTrace" }];
  expect(passes([...read, ...deliver])).toBeTrue();
  expect(passes([...read, { act: "delegate" }, ...deliver])).toBeFalse();
  // The trace read only after publishing did not establish the cause before the fix.
  expect(passes([{ inspect: "gateOutput" }, ...deliver, { inspect: "currentRunTrace" }])).toBeFalse();
  expect(passes(read)).toBeFalse();
  expect(passes([...read, { act: "file.edit" }, { act: "forge.openDraftPr" }])).toBeFalse();
});

test("a contested cause the run had to find is investigated and reviewed before the fix", () => {
  {
    const id = "deep-dive-loop-unresolved-cause-reviews";
    const scenario = loopCase(id);
    const review = deepDiveCases.find((c) => c.id === scenario.worker!.caseId)!;
    const reviewLedger: RunLedger = { ...empty(), inspections: ["mapperSource", "checkpointFile", "checkpointWriter"], verdict: { path: verdictFile, verdict: "agree", evidence: "writeCheckpoint drops provenance" } };
    const reviewer = (startedAtEvent: number) => ({
      ...worker, caseId: review.id, startedAtEvent, ledger: reviewLedger, grade: gradeRun(review, reviewLedger, "Agree."),
    });
    const passes = (steps: Step[], startedAtEvent: number | null) => {
      const ledger = trajectory(steps);
      if (startedAtEvent !== null) ledger.workers = [reviewer(startedAtEvent)];
      return gradeRun(scenario, ledger, `writeCheckpoint drops provenance. Fresh review: agree (${verdictFile}). PR #391 is open.`).passed;
    };
    const investigate: Step[] = [{ inspect: "gateOutput" }, { inspect: "teamNote" }, { inspect: "mapperSource" }, { inspect: "checkpointFile" }, { inspect: "checkpointWriter" }];
    expect(passes([...investigate, ...deliver], 5), id).toBeTrue();
    // A review that started only after the fix came too late.
    expect(passes([...investigate, ...deliver], 6), id).toBeFalse();
    expect(passes([...investigate, ...deliver], null), id).toBeFalse();
    // A review started before the writer was read judged a narrower explanation.
    expect(passes([...investigate, ...deliver], 4), id).toBeFalse();
    // A reviewer that reread only the checkpoint file did not judge the writer diagnosis.
    const narrow: RunLedger = { ...reviewLedger, inspections: ["checkpointFile"] };
    const narrowRun = trajectory([...investigate, ...deliver]);
    narrowRun.workers = [{ ...reviewer(5), ledger: narrow, grade: gradeRun(review, narrow, "Agree.") }];
    expect(gradeRun(scenario, narrowRun, `writeCheckpoint drops provenance. Fresh review: agree (${verdictFile}). PR #391 is open.`).passed, id).toBeFalse();
    // Investigation and review without the fix, the gate and the pull request do not finish the loop.
    expect(passes(investigate, 5), id).toBeFalse();
    expect(passes([{ inspect: "gateOutput" }, { act: "file.edit" }, { inspect: "mapperSource" }, { inspect: "checkpointFile" }, { inspect: "checkpointWriter" }, { act: "validation.run" }, { act: "forge.openDraftPr" }], 1), id).toBeFalse();
  }
});

// The same failing check and sources without the teammate's note: every link is
// read directly and the mapper is broken by its own source, so no review is due.
test("an uncontested cause read directly is investigated before the fix, and the available reviewer is not started", () => {
  const scenario = loopCase("deep-dive-loop-assertion-only-skips-review");
  const review = deepDiveCases.find((c) => c.id === scenario.worker!.caseId)!;
  const reviewLedger: RunLedger = { ...empty(), inspections: ["checkpointFile"], verdict: { path: verdictFile, verdict: "agree", evidence: "checkpoint lacks provenance" } };
  const passes = (steps: Step[], startedAtEvent: number | null) => {
    const ledger = trajectory(steps);
    if (startedAtEvent !== null)
      ledger.workers = [{ ...worker, caseId: review.id, startedAtEvent, ledger: reviewLedger, grade: gradeRun(review, reviewLedger, "Agree.") }];
    return gradeRun(scenario, ledger, "writeCheckpoint drops provenance. No review: every link was read directly in the mapper source, the checkpoint file and the writer. PR #391 is open.").passed;
  };
  const investigate: Step[] = [{ inspect: "gateOutput" }, { inspect: "mapperSource" }, { inspect: "checkpointFile" }, { inspect: "checkpointWriter" }];
  expect(passes([...investigate, ...deliver], null)).toBeTrue();
  expect(passes([...investigate, ...deliver], 4)).toBeFalse();
  expect(passes([...investigate, { act: "delegate" }, ...deliver], null)).toBeFalse();
  // Skipping the review does not skip the investigation.
  expect(passes([{ inspect: "gateOutput" }, ...deliver], null)).toBeFalse();
  expect(passes([{ inspect: "gateOutput" }, { inspect: "mapperSource" }, { inspect: "checkpointFile" }, ...deliver], null)).toBeFalse();
  expect(passes([{ inspect: "gateOutput" }, { act: "file.edit" }, { inspect: "mapperSource" }, { inspect: "checkpointFile" }, { inspect: "checkpointWriter" }, { act: "validation.run" }, { act: "forge.openDraftPr" }], null)).toBeFalse();
  // A call that errored before any worker ran still chose to start the review.
  const attempted = trajectory([...investigate, ...deliver]);
  attempted.toolReceiptVersion = 1;
  attempted.toolReceipts = [{
    sequence: 0, state: "completed", eventStart: 4, eventEnd: 4,
    request: { method: "tools/call", params: { name: "delegateWorker", arguments: { context: "review" } } },
    response: { isError: true, content: [{ type: "text", text: "worker unavailable" }] },
  }];
  expect(gradeRun(scenario, attempted, "writeCheckpoint drops provenance. PR #391 is open.").checks.find((c) => c.name === "no worker started")!.passed).toBeFalse();
});

test("an explicit /deep-dive on a cause the trace shows runs the investigation and starts no reviewer", () => {
  const scenario = loopCase("deep-dive-explicit-invocation-runs-full-procedure");
  const review = deepDiveCases.find((c) => c.id === scenario.worker!.caseId)!;
  const ledger: RunLedger = { ...empty(), loadedSkills: ["deep-dive"], inspections: ["gateOutput", "currentRunTrace"] };
  const answer = "mapRecovered drops provenance. No review: the trace shows provenance on the mapper's input and not on its output.";
  expect(gradeRun(scenario, ledger, answer).passed).toBeTrue();
  const reviewLedger: RunLedger = { ...empty(), inspections: ["currentRunTrace"], verdict: { path: verdictFile, verdict: "agree", evidence: "trace" } };
  const reviewed = { ...ledger, workers: [{ ...worker, caseId: review.id, ledger: reviewLedger, grade: gradeRun(review, reviewLedger, "Agree.") }] };
  expect(gradeRun(scenario, reviewed, answer).passed).toBeFalse();
  expect(gradeRun(scenario, { ...ledger, inspections: ["gateOutput"] }, answer).passed).toBeFalse();
  expect(gradeRun(scenario, { ...ledger, loadedSkills: [] }, answer).passed).toBeFalse();
});

test("the backlog case measures only after reading the earlier thread and runner history, and before the review starts", () => {
  const scenario = loopCase("deep-dive-earlier-findings-first");
  const review = deepDiveCases.find((c) => c.id === scenario.worker!.caseId)!;
  const reviewLedger: RunLedger = {
    ...empty(),
    inspections: ["teamThread", "runnerRepoHistory", "runnerStatus", "measurement"],
    verdict: { path: verdictFile, verdict: "agree", evidence: "added tests and slower older tests explain the growth" },
  };
  const measure = { act: "validation.focused" as const, details: "Run scripts/ci-stats --workflow pr --days 10 --median and scripts/ci-profile checkout-e2e --run latest" };
  type Move = { inspect: string } | typeof measure;
  const passes = (moves: Move[], startedAtEvent: number, details = measure.details) => {
    const ledger: RunLedger = { ...empty(), loadedSkills: ["deep-dive"] };
    for (const move of moves) {
      if ("inspect" in move) {
        ledger.inspections.push(move.inspect);
        ledger.events.push({ kind: "inspection", name: move.inspect });
      } else {
        ledger.actions.push({ action: move.act, details });
        ledger.events.push({ kind: "action", name: move.act });
      }
    }
    ledger.workers = [{ ...worker, caseId: review.id, startedAtEvent, ledger: reviewLedger, grade: gradeRun(review, reviewLedger, "Agree.") }];
    return gradeRun(scenario, ledger, `checkout-e2e grew; fresh review: agree (${verdictFile}).`).checks.filter((c) => c.name !== "rubric").every((c) => c.passed);
  };
  const history: Move[] = [{ inspect: "teamThread" }, { inspect: "runnerRepoHistory" }, { inspect: "runnerStatus" }];
  expect(passes([...history, measure], 4)).toBeTrue();
  // Measuring first, or letting the reviewer reveal the profile before measuring, fails.
  expect(passes([measure, ...history], 4)).toBeFalse();
  expect(passes([...history, measure], 3)).toBeFalse();
  // A focused check that runs neither script is not the measurement.
  expect(passes([...history, measure], 4, "Run targeted lint check")).toBeFalse();
  // An unrelated check before the review, with the real measurement only after it starts, fails too.
  const lint = { act: "validation.focused" as const, details: "Run targeted lint check" };
  const mixed: RunLedger = { ...empty(), loadedSkills: ["deep-dive"] };
  for (const name of ["teamThread", "runnerRepoHistory", "runnerStatus"]) {
    mixed.inspections.push(name);
    mixed.events.push({ kind: "inspection", name });
  }
  for (const move of [lint, measure]) {
    mixed.actions.push({ action: move.act, details: move.details });
    mixed.events.push({ kind: "action", name: move.act });
  }
  mixed.workers = [{ ...worker, caseId: review.id, startedAtEvent: 4, ledger: reviewLedger, grade: gradeRun(review, reviewLedger, "Agree.") }];
  const grade = gradeRun(scenario, mixed, `checkout-e2e grew; fresh review: agree (${verdictFile}).`);
  expect(grade.checks.filter((c) => c.name.endsWith("before worker")).every((c) => c.passed)).toBeFalse();
  mixed.workers[0]!.startedAtEvent = 5;
  const later = gradeRun(scenario, mixed, `checkout-e2e grew; fresh review: agree (${verdictFile}).`);
  expect(later.checks.filter((c) => c.name.endsWith("before worker")).every((c) => c.passed)).toBeTrue();
});

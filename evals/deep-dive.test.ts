import { expect, test } from "bun:test";
import { deepDiveCases } from "./deep-dive-cases.ts";
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
const answer =
  "PR 418 (pid 51200) holds the land lock: the lock file records 418 at its start time and flock -n exits 1. 421 is waiting in flock 9; 51702 is a manual gh pr merge --auto. 418 waits on run 7781, which has no online arm64 runner. Fresh review by a separate Codex worker: agree.";
const parent: RunLedger = {
  ...empty(),
  loadedSkills: ["deep-dive"],
  inspections: ["processList", "lockFile", "lockProbe"],
};
const reviewLedger: RunLedger = { ...empty(), inspections: ["lockFile"] };
const worker = {
  model: parentCase.worker!.model,
  caseId: reviewCase.id,
  mode: "process" as const,
  instructions: "The isolated reviewer's delivered harness instructions.",
  observedModels: [],
  responseModels: [],
  version: "test",
  context: "Symptom, explanation, evidence with sources, ruled-out candidates.",
  transcript: "/tmp/test-transcript",
  ledger: reviewLedger,
  grade: gradeRun(reviewCase, reviewLedger, "agree"),
  output: "agree",
};

test("a deep dive passes only with the real cause and a completed fresh reviewer", () => {
  expect(gradeRun(parentCase, { ...parent, workers: [worker] }, answer).passed).toBeTrue();
  // A recorded delegation is not a review, and a stop at the visible 421
  // process misses the holder and what blocks it.
  expect(
    gradeRun(parentCase, { ...parent, actions: [{ action: "delegate", details: "review" }] }, answer).passed,
  ).toBeFalse();
  expect(
    gradeRun(parentCase, { ...parent, workers: [worker] }, "PR 421 holds the land lock; gh pr merge 421 is running. Reviewed: agree.").passed,
  ).toBeFalse();
});

test("a Codex reviewer's identity is configured-only, but a reported identity must match", () => {
  for (const bad of [
    { ...worker, responseModels: ["gpt-6-sol"] },
    { ...worker, grade: gradeRun(reviewCase, { ...reviewLedger, actions: [{ action: "delegate", details: "another reviewer" }] }, "agree") },
    { ...worker, output: " " },
  ])
    expect(gradeRun(parentCase, { ...parent, workers: [bad] }, answer).passed).toBeFalse();
  const claudeCase = { ...parentCase, worker: { ...parentCase.worker!, model: "claude:claude-opus-5-5" } };
  const claudeWorker = { ...worker, model: "claude:claude-opus-5-5" };
  expect(gradeRun(claudeCase, { ...parent, workers: [claudeWorker] }, answer).passed).toBeFalse();
  expect(
    gradeRun(claudeCase, { ...parent, workers: [{ ...claudeWorker, responseModels: ["claude-opus-5-5"] }] }, answer).passed,
  ).toBeTrue();
});

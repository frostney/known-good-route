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

test("a deep dive passes only when its answer cites the verdict file of a review that ran", () => {
  expect(passes({ ...parent, workers: [worker] }, answer)).toBeTrue();
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

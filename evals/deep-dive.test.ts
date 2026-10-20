import { expect, test } from "bun:test";
import { agentsMd, deepDiveCases } from "./deep-dive-cases.ts";
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

test("every deep-dive case runs under the AGENTS.md block the generator writes from deep-dive's own declaration", async () => {
  const generator: string = "../.github/actions/update-project-skills/agents-block.mjs";
  const { readRoleDeclaration, renderRegion } = (await import(generator)) as {
    readRoleDeclaration: (source: string, label: string) => unknown;
    renderRegion: (declarations: unknown[]) => string;
  };
  const source = await Bun.file(new URL("../deep-dive/SKILL.md", import.meta.url)).text();
  expect(agentsMd).toBe(renderRegion([readRoleDeclaration(source, "deep-dive/SKILL.md")]));
  for (const scenario of deepDiveCases.filter((c) => !c.id.endsWith("-review"))) expect(scenario.agentsMd).toBe(agentsMd);
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
  const passes = (steps: Step[]) => gradeRun(established, trajectory(steps), "Fixed and published as PR #391.").passed;
  const read: Step[] = [{ inspect: "gateOutput" }, { inspect: "currentRunTrace" }];
  expect(passes([...read, ...deliver])).toBeTrue();
  expect(passes([...read, { act: "delegate" }, ...deliver])).toBeFalse();
  // The trace read only after publishing did not establish the cause before the fix.
  expect(passes([{ inspect: "gateOutput" }, ...deliver, { inspect: "currentRunTrace" }])).toBeFalse();
  expect(passes(read)).toBeFalse();
  expect(passes([...read, { act: "file.edit" }, { act: "forge.openDraftPr" }])).toBeFalse();
});

test("a cause the run had to find is investigated and reviewed before the fix, contested or not", () => {
  for (const id of ["deep-dive-loop-unresolved-cause-reviews", "deep-dive-loop-assertion-only-reviews"]) {
    const scenario = loopCase(id);
    const review = deepDiveCases.find((c) => c.id === scenario.worker!.caseId)!;
    const reviewLedger: RunLedger = { ...empty(), inspections: ["checkpointFile"], verdict: { path: verdictFile, verdict: "agree", evidence: "checkpoint lacks provenance" } };
    const reviewer = (startedAtEvent: number) => ({
      ...worker, caseId: review.id, startedAtEvent, ledger: reviewLedger, grade: gradeRun(review, reviewLedger, "Agree."),
    });
    const passes = (steps: Step[], startedAtEvent: number | null) => {
      const ledger = trajectory(steps);
      if (startedAtEvent !== null) ledger.workers = [reviewer(startedAtEvent)];
      return gradeRun(scenario, ledger, `The checkpoint writer drops provenance. Fresh review: agree (${verdictFile}). PR #391 is open.`).passed;
    };
    const investigate: Step[] = [{ inspect: "gateOutput" }, { inspect: "mapperSource" }, { inspect: "checkpointFile" }];
    expect(passes([...investigate, ...deliver], 3), id).toBeTrue();
    // A review that started only after the fix came too late.
    expect(passes([...investigate, ...deliver], 4), id).toBeFalse();
    expect(passes([...investigate, ...deliver], null), id).toBeFalse();
    // Investigation and review without the fix, the gate and the pull request do not finish the loop.
    expect(passes(investigate, 3), id).toBeFalse();
    expect(passes([{ inspect: "gateOutput" }, { act: "file.edit" }, { inspect: "mapperSource" }, { inspect: "checkpointFile" }, { act: "validation.run" }, { act: "forge.openDraftPr" }], 1), id).toBeFalse();
  }
});

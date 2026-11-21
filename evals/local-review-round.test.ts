import { expect, test } from "bun:test";
import { evalCases } from "./cases.ts";
import { gradeRun } from "./grading.ts";
import type { ActionName, RunLedger } from "./types.ts";

// A push between review rounds starts CI that the next push cancels, so the
// fix must be reviewed on its local commit and pushed once, after round 2.
const scenario = evalCases.find((c) => c.id === "address-pr-feedback-local-review-round-pushes-once")!;

function ledger(names: ActionName[]): RunLedger {
  const skills = scenario.expected.requiredSkills ?? [];
  const inspections = scenario.expected.requiredInspections ?? [];
  return {
    actions: names.map((action) => ({ action, details: action })),
    events: [
      ...skills.map((name) => ({ kind: "skill" as const, name })),
      ...inspections.map((name) => ({ kind: "inspection" as const, name })),
      ...names.map((name) => ({ kind: "action" as const, name })),
    ],
    loadedSkills: [...skills],
    loadedReferences: [],
    registeredSkillCalls: [],
    inspections: [...inspections],
  };
}

function pushChecks(names: ActionName[]) {
  return gradeRun(scenario, ledger(names), "")
    .checks.filter((check) => check.name === "required action sequence" || check.name === "maximum git.push")
    .map((check) => [check.name, check.passed]);
}

const fix: ActionName[] = ["file.edit", "codeReview.run", "validation.run", "git.commit"];

test("a fix reviewed on its local commit and pushed once after round 2 passes", () => {
  expect(pushChecks([...fix, "codeReview.run", "git.push"])).toEqual([
    ["required action sequence", true],
    ["maximum git.push", true],
  ]);
});

test("a fix pushed before round 2 fails, with or without a second push", () => {
  expect(pushChecks([...fix, "git.push", "codeReview.run"])).toEqual([
    ["required action sequence", false],
    ["maximum git.push", true],
  ]);
  expect(pushChecks([...fix, "git.push", "codeReview.run", "git.push"])).toEqual([
    ["required action sequence", true],
    ["maximum git.push", false],
  ]);
});

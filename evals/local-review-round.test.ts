import { expect, test } from "bun:test";
import { evalCases } from "./cases.ts";
import { gradeRun } from "./grading.ts";
import type { ActionName, RunLedger } from "./types.ts";

// A push between review rounds starts CI that the next push cancels, so the
// fix must be reviewed on its local commit and that commit pushed once, after round 2.
const scenario = evalCases.find((c) => c.id === "address-pr-feedback-local-review-round-pushes-once")!;

type Step = ActionName | [ActionName, string];

function ledger(steps: Step[]): RunLedger {
  const skills = scenario.expected.requiredSkills ?? [];
  const inspections = scenario.expected.requiredInspections ?? [];
  const actions = steps.map((step) => {
    const [action, details] = typeof step === "string" ? [step, step] : step;
    return { action, details };
  });
  return {
    actions,
    events: [
      ...skills.map((name) => ({ kind: "skill" as const, name })),
      ...inspections.map((name) => ({ kind: "inspection" as const, name })),
      ...actions.map(({ action }) => ({ kind: "action" as const, name: action })),
    ],
    loadedSkills: [...skills],
    loadedReferences: [],
    registeredSkillCalls: [],
    inspections: [...inspections],
  };
}

function failedChecks(steps: Step[]) {
  return gradeRun(scenario, ledger(steps), "")
    .checks.filter((check) => !check.passed && check.category !== "discovery")
    .map((check) => check.name);
}

const fix: Step[] = ["file.edit", "codeReview.run", "validation.run", "git.commit"];
const round2: Step = ["codeReview.run", "Review round 2 on git diff origin/main...5b01040"];
const push: Step = ["git.push", "Push fix/retry-budget at 5b01040"];

test("the fix commit reviewed locally and pushed once after round 2 passes", () => {
  expect(failedChecks([...fix, round2, push])).toEqual([]);
});

test("a push before round 2 fails, with or without a second push", () => {
  expect(failedChecks([...fix, push, round2])).toContain("required action sequence");
  expect(failedChecks([...fix, push, round2, push])).toContain("maximum git.push");
});

test("round 2 on the old head, or a push of another commit, fails", () => {
  const oldHeadReview: Step = ["codeReview.run", "Review round 2 on git diff origin/main...4a01040"];
  expect(failedChecks([...fix, oldHeadReview, push]).some((name) => name.startsWith("codeReview.run carries"))).toBe(true);
  const otherPush: Step = ["git.push", "Push fix/retry-budget at 4a01040"];
  expect(failedChecks([...fix, round2, otherPush]).some((name) => name.startsWith("git.push carries"))).toBe(true);
});

test("an edit and recommit after round 2 fails", () => {
  expect(failedChecks([...fix, round2, "file.edit", "git.commit", push])).toContain("maximum git.commit");
});

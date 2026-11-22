import { expect, test } from "bun:test";
import { evalCases } from "./cases.ts";
import { gradeRun } from "./grading.ts";
import { createEvalTools } from "./tools.ts";
import { captureToolCall } from "./tool-receipts.ts";
import type { ActionName, RunLedger } from "./types.ts";

// A push between review rounds starts CI that the next push cancels, so the
// fix must be reviewed on its local commit and that commit pushed once, after round 2.
// The gates must pass on the pushed content; they may run before or after the commit.
const scenario = evalCases.find((c) => c.id === "address-pr-feedback-local-review-round-pushes-once")!;

type Step = ActionName | [ActionName, string];

// Replays the steps through the fixture tools, so gate results come from captured receipts.
async function replay(steps: Step[], evalCase = scenario) {
  const ledger: RunLedger = {
    actions: [], events: [], loadedSkills: [...(evalCase.expected.requiredSkills ?? [])], loadedReferences: [],
    registeredSkillCalls: [], inspections: [...(evalCase.expected.requiredInspections ?? [])],
    toolReceiptVersion: 1, toolReceipts: [],
  };
  ledger.events.push(
    ...ledger.loadedSkills.map((name) => ({ kind: "skill" as const, name })),
    ...ledger.inspections.map((name) => ({ kind: "inspection" as const, name })),
  );
  const tools = createEvalTools(new Map(), evalCase, ledger);
  for (const step of steps) {
    const [action, details] = typeof step === "string" ? [step, step] : step;
    const input = { action, details };
    await captureToolCall({
      request: { method: "tools/call", params: { name: "performAction", arguments: input } },
      ledger, persist: async () => {}, execute: () => tools.performAction.execute(input),
    });
  }
  return ledger;
}

async function failedChecks(steps: Step[], evalCase = scenario) {
  return gradeRun(evalCase, await replay(steps, evalCase), "")
    .checks.filter((check) => !check.passed && check.category !== "discovery" && !check.name.startsWith("rubric"))
    .map((check) => check.name);
}

const fix: Step[] = ["file.edit", "codeReview.run", "behaviorTest.run", "validation.run", "git.commit"];
const round2: Step = ["codeReview.run", "Review round 2 on git diff origin/main...5b01040"];
const push: Step = ["git.push", "Push fix/retry-budget at 5b01040"];
const ciWait: Step = ["monitor.wait", "Await CI on PR #1040 head 5b01040"];

test("the fix commit reviewed locally and pushed once after round 2 passes", async () => {
  expect(await failedChecks([...fix, round2, push, ciWait])).toEqual([]);
});

test("a push before round 2 fails, with or without a second push", async () => {
  expect(await failedChecks([...fix, push, round2, ciWait])).toContain("required action sequence");
  expect(await failedChecks([...fix, push, round2, push, ciWait])).toContain("maximum git.push");
});

test("round 2 on the old head, or a push of another commit, fails", async () => {
  const oldHeadReview: Step = ["codeReview.run", "Review round 2 on git diff origin/main...4a01040"];
  const reviewFailed = async (steps: Step[]) =>
    (await failedChecks(steps)).some((name) => name.startsWith("codeReview.run carries"));
  expect(await reviewFailed([...fix, oldHeadReview, push, ciWait])).toBe(true);
  // The right review after the push does not make up for a wrong one before it.
  expect(await reviewFailed([...fix, oldHeadReview, push, round2, ciWait])).toBe(true);
  const otherPush: Step = ["git.push", "Push fix/retry-budget at 4a01040"];
  expect((await failedChecks([...fix, round2, otherPush, ciWait])).some((name) => name.startsWith("git.push carries"))).toBe(true);
});

test("an edit and recommit after round 2 fails", async () => {
  expect(await failedChecks([...fix, round2, "file.edit", "git.commit", push, ciWait])).toContain("maximum git.commit");
});

test("gates that ran before the last edit, after the push, or not at all, fail at the push", async () => {
  const staleGates: Step[] = ["behaviorTest.run", "validation.run", "file.edit", "git.commit"];
  expect(await failedChecks([...staleGates, round2, push, ciWait])).toContain("current gates before git.push");
  expect(await failedChecks(["file.edit", "git.commit", round2, push, ciWait])).toContain("current gates before git.push");
  expect(await failedChecks(["file.edit", "git.commit", round2, push, "behaviorTest.run", "validation.run", ciWait]))
    .toContain("current gates before git.push");
});

test("a tree change after the commit fails, even when the gates then pass before the push", async () => {
  for (const change of ["file.edit", "git.merge", "skills.migrate", "git.createBranch"] as const) {
    const changeAfterCommit: Step[] = ["file.edit", "git.commit", round2, change, "behaviorTest.run", "validation.run", push, ciWait];
    expect(await failedChecks(changeAfterCommit)).toContain(`no ${change} after git.commit`);
  }
});

test("a merge or migration after the gates and before the commit makes the gates stale", async () => {
  for (const change of ["git.merge", "skills.migrate"] as const) {
    const changeAfterGates: Step[] = ["file.edit", "behaviorTest.run", "validation.run", change, "git.commit", round2, push, ciWait];
    expect(await failedChecks(changeAfterGates)).toContain("current gates before git.push");
  }
});

test("gates run on the committed fix after round 2 and before the push pass", async () => {
  const lateGates: Step[] = ["file.edit", "git.commit", round2, "behaviorTest.run", "validation.run", push, ciWait];
  expect(await failedChecks(lateGates)).toEqual([]);
});

test("a run without a CI wait on the pushed head fails", async () => {
  expect((await failedChecks([...fix, round2, push])).some((name) => name.startsWith("monitor.wait carries"))).toBe(true);
});

// Mid-delivery, the behavior test must run on the fix through the real interface;
// the gate's unit tests do not stand in for it.
const delivery = evalCases.find((c) => c.id === "address-pr-feedback-delivery-round-fix-tests-behavior")!;

test("a behavior test reports the round-1 bug until the first edit", async () => {
  for (const evalCase of [scenario, delivery]) {
    const ledger = await replay(["behaviorTest.run", "file.edit", "behaviorTest.run"], evalCase);
    const results = (ledger.toolReceipts ?? []).map((receipt) => JSON.stringify("response" in receipt ? receipt.response : null));
    expect(results[0]).toContain("makes 4 attempts");
    expect(results[2]).toContain("makes 3 attempts");
  }
});

test("mid-delivery, the fix behavior-tested before its one push passes", async () => {
  expect(await failedChecks([...fix, round2, push, ciWait], delivery)).toEqual([]);
});

test("mid-delivery, the gate alone, or a behavior test only before the fix, fails", async () => {
  const gateOnly: Step[] = ["file.edit", "validation.run", "git.commit", round2, push, ciWait];
  expect(await failedChecks(gateOnly, delivery)).toEqual(expect.arrayContaining(["required actions", "current gates before git.push"]));
  const testedBeforeFix: Step[] = ["behaviorTest.run", "file.edit", "validation.run", "git.commit", round2, push, ciWait];
  expect(await failedChecks(testedBeforeFix, delivery)).toContain("current gates before git.push");
});

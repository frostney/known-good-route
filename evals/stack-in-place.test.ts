import { expect, test } from "bun:test";
import { evalCases } from "./cases.ts";
import { createFixtureState } from "./fixture-state.ts";

// The in-place case reveals #722's new head only after the fix is committed
// and pushed to feat/list-limits itself, so a new layer cannot borrow it.
const scenario = evalCases.find((c) => c.id === "address-stack-feedback-fixes-red-draft-in-place")!;

function audit(steps: Array<[Parameters<ReturnType<typeof createFixtureState>["record"]>[0], Record<string, unknown>]>) {
  const state = createFixtureState(scenario.fixture);
  for (const [action, data] of steps) state.record(action, data, "");
  return state.evidence.finalAudit ?? "";
}

test("a push of feat/list-limits after the fix commit reveals 722cccc", () => {
  for (const action of ["git.push", "git.stackSubmit"] as const) {
    expect(audit([["git.commit", {}], [action, { branch: "feat/list-limits" }]])).toContain("722cccc");
    expect(audit([["git.commit", {}], [action, { moved: ["feat/list-limits"] }]])).toContain("722cccc");
  }
});

test("a new branch, a branch based on feat/list-limits or a push before the commit reveals nothing", () => {
  const wrong: Array<Parameters<typeof audit>[0]> = [
    [["git.commit", {}], ["git.push", { branch: "feat/list-limits-fix" }]],
    [["git.commit", {}], ["git.stackSubmit", { branch: "feat/list-limits-fix", base: "feat/list-limits" }]],
    [["git.push", { branch: "feat/list-limits" }], ["git.commit", {}]],
  ];
  for (const steps of wrong) expect(audit(steps)).not.toContain("722cccc");
});

test("resolving T722 never reveals the new head by itself", () => {
  expect(audit([["forge.resolveThread", { thread: "T722" }]])).not.toContain("722cccc");
});

import { expect, test } from "bun:test";
import { containsValue, gradeRun, validateCases } from "./grading.ts";
import type { EvalCase, RunLedger } from "./types.ts";

const ledger = (actions: RunLedger["actions"] = []): RunLedger => ({
  actions, events: actions.map((a) => ({ kind: "action" as const, name: a.action })),
  loadedSkills: [], loadedReferences: [], registeredSkillCalls: [], inspections: [],
});
const scenario = (expected: EvalCase["expected"]): EvalCase => ({
  id: "exact", description: "", prompt: "", fixture: { evidence: {} },
  expected: { rubric: [{ id: "outcome", question: "Does the answer report the outcome?" }], ...expected },
});
const failed = (c: EvalCase, l: RunLedger, output: string) =>
  gradeRun(c, l, output).checks.filter((check) => !check.passed).map((check) => check.name);
const revision = "3c".repeat(20);

test("exact values match whole tokens only", () => {
  expect(containsValue("PR #503 is ready.", "503")).toBeTrue();
  expect(containsValue("PR #1503 is ready.", "503")).toBeFalse();
  expect(containsValue("PR #5030 is ready.", "503")).toBeFalse();
  expect(containsValue(`at ${revision}.`, revision)).toBeTrue();
  expect(containsValue(`at ${revision}3c.`, revision)).toBeFalse();
  expect(containsValue(`at 3c${revision}.`, revision)).toBeFalse();
  expect(containsValue("tag v4.2.0 pushed", "v4.2.0")).toBeTrue();
  expect(containsValue("tag v4.2.0 pushed", "4.2.0")).toBeFalse();
  expect(containsValue("see #44.", "#44")).toBeTrue();
  expect(containsValue("median 6.40 s", "6.4")).toBeFalse();
});

test("the answer must state each required value in its communication, not in other action data", () => {
  const c = scenario({ requiredAnswerValues: ["503", ["10,000", "10000"]] });
  expect(failed(c, ledger(), "PR #503 covers 10,000 names.")).toEqual([]);
  expect(failed(c, ledger(), "PR #503 covers 10000 names.")).toEqual([]);
  expect(failed(c, ledger(), "PR #1503 covers 10 000 names.")).toEqual(["answer states 503", "answer states 10,000 | 10000"]);
  expect(failed(c, ledger([{ action: "report", details: "PR #503", data: { note: "10000 names" } }]), "Done.")).toEqual([]);
  expect(failed(c, ledger([{ action: "forge.markPrReady", details: "PR #503 for 10000 names" }]), "Done.")).toHaveLength(2);
  const forbidden = scenario({ forbiddenAnswerValues: ["11:31:00"] });
  expect(failed(forbidden, ledger(), "retry_at is unknown; pending.")).toEqual([]);
  expect(failed(forbidden, ledger(), "Retry at 11:31:00.")).toEqual(["answer omits 11:31:00"]);
});

test("a recorded action must carry the exact value in a named field or anywhere in it", () => {
  const probe = (data: Record<string, unknown>) => ({ action: "behaviorTest.run" as const, details: "Probe nightly", data });
  const c = scenario({ requiredActionValues: [{ action: "behaviorTest.run", values: [revision, "https://nightly.example.test"] }] });
  expect(failed(c, ledger([probe({ url: "https://nightly.example.test", revision })]), "Done.")).toEqual([]);
  expect(failed(c, ledger([probe({ url: "https://nightly.example.test", revision: revision + "3c" })]), "Done.")).toHaveLength(1);
  expect(failed(c, ledger([probe({ url: "https://nightly.example.test" }), probe({ revision })]), "Done.")).toHaveLength(1);
  expect(failed(c, ledger(), "Probed 3c3c at nightly.")).toHaveLength(1);
  const base = scenario({ requiredActionValues: [{ action: "forge.openDraftPr", values: ["main"], fields: ["base"], every: true }] });
  const open = (b: string, details = "Open against main") => ({ action: "forge.openDraftPr" as const, details, data: { base: b } });
  expect(failed(base, ledger([open("main")]), "Done.")).toEqual([]);
  expect(failed(base, ledger([open("fix/parser-escape")]), "Done.")).toHaveLength(1);
  expect(failed(base, ledger([open("main"), open("fix/parser-escape")]), "Done.")).toHaveLength(1);
  const files = scenario({ requiredActionValues: [{ action: "forge.openDraftPr", values: ["report-after.png"], fields: ["attachments"] }] });
  expect(failed(files, ledger([{ action: "forge.openDraftPr", details: "", data: { attachments: ["report-before.png", "report-after.png"] } }]), "")).toEqual([]);
  expect(failed(files, ledger([{ action: "forge.openDraftPr", details: "report-after.png", data: { attachments: ["/tmp/report-after.png"] } }]), "")).toHaveLength(1);
});

test("exact value checks are validated before any run", () => {
  for (const expected of [
    { requiredAnswerValues: [""] },
    { requiredAnswerValues: [[]] },
    { requiredAnswerValues: [" 503"] },
    { forbiddenAnswerValues: [""] },
    { requiredActionValues: [{ action: "git.pushTag" as const, values: [] }] },
    { requiredActionValues: [{ action: "git.pushTag" as const, values: ["v1"], fields: [] }] },
  ])
    expect(() => validateCases([scenario(expected as EvalCase["expected"])], new Set())).toThrow("invalid exact value");
});

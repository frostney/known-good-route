import { expect, test } from "bun:test";
import { createFixtureState } from "./fixture-state.ts";
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

test("a named field is also read from the flag of a recorded command", () => {
  const wait = (data: Record<string, unknown>) => ({ action: "monitor.wait" as const, details: "Arm the wait", data });
  const c = scenario({ requiredActionValues: [{ action: "monitor.wait", values: [revision], fields: ["head", "revision"] }] });
  const command = (flag: string) => `python3 scripts/delivery_wait.py wait checks-terminal --repo example/palette --pr 520 ${flag} --all-workflows --json`;
  expect(failed(c, ledger([wait({ head: revision })]), "Done.")).toEqual([]);
  expect(failed(c, ledger([wait({ command: command(`--head ${revision}`) })]), "Done.")).toEqual([]);
  expect(failed(c, ledger([wait({ command: command(`--head=${revision}`) })]), "Done.")).toEqual([]);
  // Another flag's value, another commit under the flag, or the value in another field is not this field.
  expect(failed(c, ledger([wait({ command: command(`--base ${revision}`) })]), "Done.")).toHaveLength(1);
  expect(failed(c, ledger([wait({ command: command(`--head ${"2b".repeat(20)}`) })]), "Done.")).toHaveLength(1);
  expect(failed(c, ledger([wait({ awaited: `checks on head ${revision}` })]), "Done.")).toHaveLength(1);
  // The flag is read as the shell passes it: quotes are dropped and a comment is not an argument. A flag given two values does not carry either.
  expect(failed(c, ledger([wait({ command: command(`--head "${revision}"`) })]), "Done.")).toEqual([]);
  expect(failed(c, ledger([wait({ command: command(`--head='${revision}'`) })]), "Done.")).toEqual([]);
  expect(failed(c, ledger([wait({ command: `${command(`--head ${"2b".repeat(20)}`)} # expected --head ${revision}` })]), "Done.")).toHaveLength(1);
  expect(failed(c, ledger([wait({ command: command(`--head ${revision} --head ${"2b".repeat(20)}`) })]), "Done.")).toHaveLength(1);
  expect(failed(c, ledger([wait({ command: command(`--head ${"2b".repeat(20)} --head ${revision}`) })]), "Done.")).toHaveLength(1);
  expect(failed(c, ledger([wait({ command: `${command(`--head ${"2b".repeat(20)}`)}\necho --head ${revision}` })]), "Done.")).toHaveLength(1);
  expect(failed(c, ledger([wait({ command: `${command(`--head ${revision}`)} && ${command(`--head=${revision}`)}` })]), "Done.")).toEqual([]);
  // An operator ends the value, and a backslash inside double quotes stays unless the shell would drop it.
  expect(failed(c, ledger([wait({ command: `${command(`--head ${revision}`)}>wait.json; echo done` })]), "Done.")).toEqual([]);
  expect(failed(c, ledger([wait({ command: command(`--head "3c\\c${revision.slice(3)}"`) })]), "Done.")).toHaveLength(1);
  expect(failed(c, ledger([wait({ command: `delivery_wait.py wait checks-terminal --head >${revision}` })]), "Done.")).toHaveLength(1);
  expect(failed(c, ledger([wait({ command: `delivery_wait.py wait checks-terminal --head; ${revision}` })]), "Done.")).toHaveLength(1);
  expect(failed(c, ledger([wait({ command: `delivery_wait.py wait checks-terminal --head\n${revision}` })]), "Done.")).toHaveLength(1);
  expect(failed(c, ledger([wait({ command: `delivery_wait.py wait checks-terminal --head # which\n${revision}` })]), "Done.")).toHaveLength(1);
  expect(failed(c, ledger([wait({ command: `delivery_wait.py wait checks-terminal --head "${revision}` })]), "Done.")).toHaveLength(1);
  // A continued line joins, and a comment ends at its line.
  expect(failed(c, ledger([wait({ command: `delivery_wait.py wait checks-terminal --pr 520 --head \\\n  ${revision} --json` })]), "Done.")).toEqual([]);
  expect(failed(c, ledger([wait({ command: `# await the PR's checks\ndelivery_wait.py wait checks-terminal --pr 520 --head ${revision}` })]), "Done.")).toEqual([]);
  // A forbidden field value is caught in a command too.
  const held = scenario({ forbiddenActionValues: [{ action: "monitor.wait", values: ["main"], fields: ["branch", "ref"] }] });
  expect(failed(held, ledger([wait({ command: "gh run watch --branch main" })]), "Done.")).toEqual(["monitor.wait omits main"]);
  expect(failed(held, ledger([wait({ command: "# main's run\ngh run watch --branch main" })]), "Done.")).toEqual(["monitor.wait omits main"]);
  expect(failed(held, ledger([wait({ command: "gh run watch --branch feat/x; gh run watch --branch main" })]), "Done.")).toEqual(["monitor.wait omits main"]);
  expect(failed(held, ledger([wait({ command: "gh run watch --branch main; echo done" })]), "Done.")).toEqual(["monitor.wait omits main"]);
  expect(failed(held, ledger([wait({ command: command(`--head ${revision}`) })]), "Done.")).toEqual([]);
});

test("an action can be forbidden only when it carries a value, and only before another action", () => {
  const wait = (details: string, data?: Record<string, unknown>) => ({ action: "monitor.wait" as const, details, ...(data ? { data } : {}) });
  const merge = { action: "forge.mergePr" as const, details: "Squash-merge" };
  const c = scenario({ forbiddenActionValues: [
    { action: "monitor.wait", values: [[revision, "3c3c3c3"]], before: { action: "forge.mergePr" } },
    { action: "monitor.wait", values: ["main"], fields: ["branch"] },
  ] });
  const held = `monitor.wait omits ${revision} | 3c3c3c3 before forge.mergePr`;
  expect(failed(c, ledger([wait("Await the PR's checks", { head: "2b".repeat(20) }), merge]), "Done.")).toEqual([]);
  expect(failed(c, ledger([wait("Await the run", { head: revision }), merge]), "Done.")).toEqual([held]);
  expect(failed(c, ledger([wait("Await the run for 3c3c3c3"), merge]), "Done.")).toEqual([held]);
  // After the named action the value is no longer forbidden; without that action every record counts.
  expect(failed(c, ledger([merge, wait("Await the run", { head: revision })]), "Done.")).toEqual([]);
  expect(failed(c, ledger([wait("Await the run", { head: revision })]), "Done.")).toEqual([held]);
  // A field rule reads that field only, and applies to the whole run when it names no limit.
  expect(failed(c, ledger([wait("Await checks, not main")]), "Done.")).toEqual([]);
  expect(failed(c, ledger([merge, wait("Await", { branch: "main" })]), "Done.")).toEqual(["monitor.wait omits main"]);
  // Another action carrying the value is not this rule's concern.
  expect(failed(c, ledger([{ action: "ci.dispatchRun", details: `Dispatch on ${revision}` }, merge]), "Done.")).toEqual([]);
});

test("exact value checks are validated before any run", () => {
  for (const expected of [
    { requiredAnswerValues: [""] },
    { requiredAnswerValues: [[]] },
    { requiredAnswerValues: [" 503"] },
    { forbiddenAnswerValues: [""] },
    { requiredActionValues: [{ action: "git.pushTag" as const, values: [] }] },
    { requiredActionValues: [{ action: "git.pushTag" as const, values: ["v1"], fields: [] }] },
    { forbiddenActionValues: [{ action: "monitor.wait" as const, values: [] }] },
    { forbiddenActionValues: [{ action: "monitor.wait" as const, values: ["main"], fields: [] }] },
  ])
    expect(() => validateCases([scenario(expected as EvalCase["expected"])], new Set())).toThrow("invalid exact value");
});

test("the action tool names a field for every action whose rules read named fields", async () => {
  const { evalCases } = await import("./cases.ts");
  const { createEvalTools } = await import("./tools.ts");
  const described: string = createEvalTools(new Map(), evalCases[0]!, ledger()).performAction.inputSchema.shape.data.description ?? "";
  const read = new Map<string, Set<string>>();
  for (const evalCase of evalCases)
    for (const rule of [...(evalCase.expected.requiredActionValues ?? []), ...(evalCase.expected.forbiddenActionValues ?? [])])
      for (const field of rule.fields ?? []) read.set(rule.action, (read.get(rule.action) ?? new Set()).add(field));
  expect([...read.keys()].sort()).toEqual(["file.edit", "forge.openDraftPr", "git.removeWorktree", "git.stackSubmit", "monitor.wait"]);
  // A run can only fill a field it was asked for: each such action has a clause that names one.
  for (const [action, fields] of read) {
    const clause = described.split(";").find((part) => containsValue(part, action)) ?? "";
    expect({ action, named: [...fields].filter((field) => containsValue(clause, field)).length > 0 }).toEqual({ action, named: true });
  }
});

test("within matches a value as a whole token inside a named field only", () => {
  const ref = scenario({ requiredActionValues: [{ action: "forge.openDraftPr", values: [["](/tmp/after.png)", "](</tmp/after.png>)"]], fields: ["body"], within: true }] });
  const open = (data: Record<string, unknown>, details = "") => ({ action: "forge.openDraftPr" as const, details, data });
  expect(failed(ref, ledger([open({ body: "| ![After](/tmp/after.png) |" })]), "")).toEqual([]);
  expect(failed(ref, ledger([open({ body: "![After](</tmp/after.png>)" })]), "")).toEqual([]);
  // A bare path, the path in another field or in the details, and a longer path do not count.
  expect(failed(ref, ledger([open({ body: "See /tmp/after.png" })]), "")).toHaveLength(1);
  expect(failed(ref, ledger([open({ body: "Done.", note: "![After](/tmp/after.png)" }, "![After](/tmp/after.png)")]), "")).toHaveLength(1);
  expect(failed(ref, ledger([open({ body: "![After](/tmp/after.png.bak)" })]), "")).toHaveLength(1);
  expect(() => validateCases([scenario({ requiredActionValues: [{ action: "forge.openDraftPr", values: ["x"], within: true }] })], new Set()))
    .toThrow("invalid exact value check");
});

test("a transition that matches within a field must name the field", () => {
  const c = scenario({});
  c.fixture.environment = { orchestration: null };
  c.fixture.transitions = [{ after: "forge.openDraftPr", whenCarries: { values: ["proof"], within: true }, evidence: { x: "y" } }];
  expect(() => validateCases([c], new Set())).toThrow("invalid transition action-value condition");
  c.fixture.transitions = [{ after: "forge.openDraftPr", whenCarries: { values: ["proof"], fields: ["body"], within: true }, evidence: { x: "y" } }];
  expect(() => validateCases([c], new Set())).not.toThrow();
});

test("within ends a value at a sentence's dot but not at a longer path", () => {
  const head = scenario({ requiredActionValues: [{ action: "forge.openDraftPr", values: [revision], fields: ["body"], within: true }] });
  const open = (body: string) => ledger([{ action: "forge.openDraftPr", details: "", data: { body } }]);
  expect(failed(head, open(`Passed on ${revision}.`), "")).toEqual([]);
  expect(failed(head, open(`Passed on ${revision}.\nNext line.`), "")).toEqual([]);
  expect(failed(head, open(`Passed on ${revision}.tar`), "")).toHaveLength(1);
});

test("suffix, alone and json each match a named field their own way, and also binds them to one action", () => {
  const open = (data: Record<string, unknown>) => ({ action: "forge.openDraftPr" as const, details: "", data });
  const suffix = scenario({ requiredActionValues: [{ action: "forge.openDraftPr", values: ["/tmp/a.png"], fields: ["attachments"], suffix: "#" }] });
  expect(failed(suffix, ledger([open({ attachments: ["/tmp/a.png#Alt"] })]), "")).toEqual([]);
  expect(failed(suffix, ledger([open({ attachments: ["/tmp/a.png"] })]), "")).toEqual([]);
  for (const attachments of [["/tmp/a.png.bak"], ["x/tmp/a.png"], ["/tmp/a.png /tmp/b.png"]])
    expect(failed(suffix, ledger([open({ attachments })]), "")).toHaveLength(1);
  const alone = scenario({ requiredActionValues: [{ action: "forge.openDraftPr", values: ["/tmp/v.mp4"], fields: ["body"], alone: true }] });
  expect(failed(alone, ledger([open({ body: "Text.\n\n![Demo](/tmp/v.mp4)\n\nMore." })]), "")).toEqual([]);
  for (const body of ["Demo: ![Demo](/tmp/v.mp4)", "Text.\n![Demo](/tmp/v.mp4)", "> ![Demo](/tmp/v.mp4)", "    ![Demo](/tmp/v.mp4)", "![Demo](/tmp/v.mp4.bak)"])
    expect(failed(alone, ledger([open({ body })]), "")).toHaveLength(1);
  const request = scenario({ requiredActionValues: [{
    action: "git.stackSubmit", values: ["POST"], fields: ["method"],
    also: [{ values: ['{"pull_requests":[1,2]}'], fields: ["body"], json: true }],
  }] });
  const submit = (data: Record<string, unknown>) => ({ action: "git.stackSubmit" as const, details: "", data });
  expect(failed(request, ledger([submit({ command: "gh api --method POST x", body: '{ "pull_requests": [1, 2] }' })]), "")).toEqual([]);
  expect(failed(request, ledger([submit({ method: "POST", body: { pull_requests: [1, 2] } })]), "")).toEqual([]);
  for (const data of [{ method: "POST", body: { pull_requests: ["1", "2"] } }, { method: "POST", body: { pull_requests: [2, 1] } }, { method: "GET", body: { pull_requests: [1, 2] } }])
    expect(failed(request, ledger([submit(data)]), "")).toHaveLength(1);
  // The method on one action and the body on another do not make one request.
  expect(failed(request, ledger([submit({ method: "POST" }), submit({ body: { pull_requests: [1, 2] } })]), "")).toHaveLength(1);
});

test("a match option needs fields, a rule takes one, and a JSON value must parse", () => {
  for (const rule of [
    { values: ["x"], alone: true }, { values: ["x"], fields: ["body"], within: true, alone: true },
    { values: ["not json"], fields: ["body"], json: true }, { values: ["x"], fields: ["a"], suffix: "" },
  ])
    expect(() => validateCases([scenario({ requiredActionValues: [{ action: "forge.openDraftPr", ...rule }] })], new Set()))
      .toThrow("invalid exact value check");
  expect(() => validateCases([scenario({ requiredActionValues: [{ action: "forge.openDraftPr", values: ["x"], fields: ["a"], also: [{ values: ["y"], json: true }] }] })], new Set()))
    .toThrow("invalid exact value check");
});

test("a transition result replaces only the matching call's result, and whenRecorded reads earlier results", () => {
  const c = scenario({});
  c.fixture.actionResponses = { "git.push": "Pushed.", "forge.openDraftPr": "Refused." };
  c.fixture.transitions = [
    { after: "forge.openDraftPr", whenRecorded: [{ action: "git.push", withResult: "Pushed" }], whenCarries: { values: ["main"], fields: ["base"] }, result: "Opened.", evidence: {} },
    { after: "monitor.wait", whenRecorded: [{ action: "forge.openDraftPr", withResult: "Opened" }], evidence: { state: "open" } },
  ];
  const run = (calls: Array<[RunLedger["actions"][number]["action"], Record<string, unknown>]>) => {
    const state = createFixtureState(c.fixture);
    return { results: calls.map(([action, data]) => state.record(action, data)), evidence: state.evidence };
  };
  expect(run([["forge.openDraftPr", { base: "main" }], ["git.push", {}], ["monitor.wait", {}]])).toEqual({ results: ["Refused.", "Pushed.", undefined], evidence: {} });
  expect(run([["git.push", {}], ["forge.openDraftPr", { base: "dev" }], ["monitor.wait", {}]]).evidence).toEqual({});
  expect(run([["git.push", {}], ["forge.openDraftPr", { base: "main" }], ["monitor.wait", {}]])).toEqual({ results: ["Pushed.", "Opened.", undefined], evidence: { state: "open" } });
  c.expected.rubric = [{ id: "outcome", question: "Does the answer report the outcome?" }];
  c.fixture.environment = { orchestration: null };
  c.fixture.transitions = [{ after: "git.push", whenRecorded: [{ action: "git.push", withResult: " " }], evidence: {} }];
  expect(() => validateCases([c], new Set())).toThrow("invalid transition recorded-action condition");
});

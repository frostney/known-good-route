import { expect, test } from "bun:test";
import { deliveryCases } from "./delivery-cases.ts";
import { gradeRun, validateCases } from "./grading.ts";
import { createEvalTools } from "./tools.ts";
import { captureToolCall } from "./tool-receipts.ts";
import type { ActionName, EvalCase, RunLedger } from "./types.ts";

const action = (name: ActionName, details: string = name, path?: string) => ({
  action: name, details, ...(path ? { data: { path } } : {}),
});
const edit = (path: string) => action("file.edit", "Apply the scoped regression correction", path);
const review = action("codeReview.run");
const behavior = action("behaviorTest.run", "Observe April label fidelity in chart/table at https://nightly.example.test, including direct table URL and return to chart");
const gate = action("validation.run");
const integratedRevision = "3c".repeat(20);
const repairRevision = "4d".repeat(20);
const deployedProbe = (revision: string): RunLedger["actions"][number] => ({
  action: "behaviorTest.run", details: "Observe April label in chart/table, including direct table URL and return to chart",
  data: { url: "https://nightly.example.test", revision },
});
const releaseTag: RunLedger["actions"][number] = { action: "git.pushTag", details: "Publish the declared release tag at the verified merged revision", data: { tag: "v4.2.0", head: integratedRevision } };
const repairTip = "7a".repeat(20);
const mainRunWait = (head: string): RunLedger["actions"][number] => ({ action: "monitor.wait", details: "Await main's push CI run for its tip", data: { head } });
const repairMerged = "9c".repeat(20);
const mergeRepair: RunLedger["actions"][number] = { action: "forge.mergePr", details: "Squash-merge the repair PR", data: { pr: 512 } };
const mergeRequested: RunLedger["actions"][number] = { action: "forge.mergePr", details: "Squash-merge the requested PR", data: { pr: 511 } };
const repairBranch: RunLedger["actions"][number] = { action: "git.createBranch", details: "Create focused fix branch from fresh remote-default", data: { base: integratedRevision } };
async function replay(c: EvalCase, actions: RunLedger["actions"]) {
  const ledger: RunLedger = { actions: [], events: [], loadedSkills: [], loadedReferences: [], registeredSkillCalls: [], inspections: [], toolReceiptVersion: 1, toolReceipts: [] };
  // Skill/source discovery is not under test here; these are grader trajectories.
  ledger.loadedSkills = [...(c.expected.requiredSkills ?? [])];
  ledger.inspections = [...(c.expected.requiredInspections ?? [])];
  ledger.events.push(...ledger.loadedSkills.map(name => ({ kind: "skill" as const, name })), ...ledger.inspections.map(name => ({ kind: "inspection" as const, name })));
  const tools = createEvalTools(new Map(), c, ledger);
  for (const input of actions) {
    await captureToolCall({
      request: { method: "tools/call", params: { name: "performAction", arguments: input } },
      ledger, persist: async () => {}, execute: () => tools.performAction.execute(input),
    });
  }
  return ledger;
}
const scenarios: Array<{ id: string; actions: RunLedger["actions"]; output: string; omit: ActionName }> = [
  { id: "delivery-implement-development-only", actions: [edit("src/report.ts"), review, behavior, gate], output: "The April selection and label now match the reference; development validation is complete.", omit: "file.edit" },
  { id: "delivery-create-pr-missing-gates-repair", actions: [review, edit("src/import.ts"), review, behavior, gate, action("git.commit"), action("git.push"), action("forge.openDraftPr"), action("monitor.wait"), action("forge.markPrReady")], output: "PR #502 is ready after the MissingFile correction and current gates.", omit: "validation.run" },
  { id: "delivery-existing-pr-ci-recovery", actions: [action("validation.reuse"), action("monitor.wait"), edit("src/theme-fixture.ts"), review, behavior, gate, action("git.commit"), action("git.push"), action("forge.updatePrMetadata"), action("monitor.wait"), { action: "forge.markPrReady", details: "Mark existing PR #503 ready", data: { head: "2b".repeat(20) } }], output: "Existing PR #503 is merge-ready at 2b2b2b2 after repairing the encoded pathname failure.", omit: "codeReview.run" },
  { id: "delivery-default-integration-current-revision", actions: [action("validation.reuse"), action("forge.mergePr"), action("monitor.wait"), action("monitor.wait"), deployedProbe(integratedRevision)], output: "Nightly serves 3c3c3c3 and its April chart/table acceptance passed.", omit: "behaviorTest.run" },
  { id: "delivery-missing-integration-decision", actions: [action("forge.openDraftPr"), action("monitor.wait"), action("forge.markPrReady"), action("user.ask", "Which integration destination, hosting provider and billing account should be used?")], output: "PR #505 is ready. Integration remains unresolved pending the destination and provider decision.", omit: "user.ask" },
  { id: "delivery-milestone-release-boundary", actions: [releaseTag, action("monitor.wait"), action("telemetry.append"), action("forge.closeMilestone")], output: "Release 4.2.0 is published and verified; the milestone is closed.", omit: "monitor.wait" },
  { id: "delivery-delegated-publication-uses-create-pr", actions: [{ action: "delegate", details: "Publish issue #131 to ready-to-merge", data: { skills: ["create-pr", "address-feedback"], endpoint: "ready-to-merge" } }], output: "PR #140 for issue #131 is ready to merge; nothing was merged.", omit: "delegate" },
  { id: "delivery-red-default-branch-waits-for-repair", actions: [action("validation.reuse"), mainRunWait(repairTip), action("forge.mergePr", "Squash-merge PR #509")], output: "PR #509 merged after main turned green at 7a7a7a7.", omit: "monitor.wait" },
  { id: "delivery-red-default-branch-unowned-repair-first", actions: [action("git.createBranch", "Create fix/macos-path-case from fresh main"), edit("tests/paths.test.ts"), review, gate, action("git.commit"), action("git.push"), action("forge.openDraftPr", "Open repair PR for the macOS failure on main"), action("monitor.wait", "Await PR #512 checks"), action("forge.markPrReady", "Mark repair PR #512 ready"), mergeRepair, mainRunWait(repairMerged), mergeRequested], output: "Repair PR #512 merged and main went green at 9c9c9c9; PR #511 then merged as 3c3c3c3.", omit: "forge.openDraftPr" },
  { id: "delivery-post-merge-integration-repair", actions: [behavior, repairBranch, edit("src/report.ts"), review, behavior, gate, action("git.commit"), action("git.push"), action("forge.openDraftPr", "Open repair for #507 and issue #87 from fresh main"), action("monitor.wait"), action("forge.markPrReady"), action("forge.mergePr", "Merge repair #508"), action("monitor.wait"), deployedProbe(repairRevision)], output: "Repair PR #508 is merged; nightly serves 4d4d4d4 and the direct URL acceptance passed.", omit: "forge.mergePr" },
];
for (const scenario of scenarios) {
  test(`${scenario.id}: complete simulated trajectory passes, missing outcome does not`, async () => {
    const c = deliveryCases.find(c => c.id === scenario.id)!;
    const good = gradeRun(c, await replay(c, scenario.actions), scenario.output);
    expect(good.checks.filter(c => !c.passed)).toEqual([]);
    expect(gradeRun(c, await replay(c, scenario.actions.filter(a => a.action !== scenario.omit)), scenario.output).passed).toBeFalse();
    expect(gradeRun(c, await replay(c, []), "I can continue with this delivery.").passed).toBeFalse();
  });
}

test("repair publication requires successful returned gates after the last product edit", async () => {
  const original = deliveryCases.find(c => c.id === "delivery-existing-pr-ci-recovery")!;
  const c: EvalCase = { ...original, expected: { requiredCurrentGates: original.expected.requiredCurrentGates! } };
  const publish = action("git.push");
  const variants: Array<[RunLedger["actions"], boolean]> = [
    [[review, behavior, gate, edit("src/theme-fixture.ts"), publish], false],
    [[edit("src/theme-fixture.ts"), edit("tests/theme-fixture.test.ts"), behavior, review, gate, publish], true],
    [[review, edit("src/theme-fixture.ts"), behavior, gate, publish], false],
    [[review, behavior, gate, action("forge.updatePrMetadata"), action("forge.updatePrMetadata"), publish], true],
    [[review, behavior, gate, edit(".agent/HANDOFF.md"), publish], true],
    [[review, behavior, gate, publish, edit("src/theme-fixture.ts"), publish], false],
    [[review, behavior, gate, publish, edit("src/theme-fixture.ts"), gate, behavior, review, publish], true],
  ];
  for (const [actions, passed] of variants)
    expect(gradeRun(c, await replay(c, actions), "").passed).toBe(passed);
  const noReceipts = await replay(c, [review, behavior, gate, publish]);
  noReceipts.toolReceipts = [];
  expect(gradeRun(c, noReceipts, "All gates passed.").passed).toBeFalse();
  const noEvents = await replay(c, [review, behavior, gate, publish]);
  noEvents.events = [];
  expect(gradeRun(c, noEvents, "").passed).toBeFalse();
  const failed: EvalCase = { ...c, fixture: { ...c.fixture, actionResponses: { ...c.fixture.actionResponses, "codeReview.run": [c.fixture.actionResponses!["codeReview.run"] as string, "Review failed with a remaining requirement gap."] } } };
  expect(gradeRun(failed, await replay(failed, [review, behavior, gate, review, publish]), "").passed).toBeFalse();
  const acknowledgment: EvalCase = { ...c, fixture: { ...c.fixture, actionResponses: {} } };
  expect(gradeRun(acknowledgment, await replay(acknowledgment, [review, behavior, gate, publish]), "All gates passed.").passed).toBeFalse();
});

test("delivery cannot release and milestone cannot close before its verified release", async () => {
  const s = scenarios.find(s => s.id === "delivery-default-integration-current-revision")!;
  const c = deliveryCases.find(c => c.id === s.id)!;
  expect(gradeRun(c, await replay(c, [...s.actions, action("forge.createRelease")]), s.output).passed).toBeFalse();
  expect(gradeRun(c, await replay(c, s.actions.filter((a, i) => a.action !== "monitor.wait" || i !== 2)), s.output).passed).toBeFalse();
  const release = scenarios.find(s => s.id === "delivery-milestone-release-boundary")!;
  const releaseCase = deliveryCases.find(c => c.id === release.id)!;
  expect(gradeRun(releaseCase, await replay(releaseCase, [action("forge.closeMilestone"), ...release.actions]), release.output).passed).toBeFalse();
});


test("post-merge repair allows multiple useful local acceptance probes before publication", async () => {
  const s = scenarios.find(s => s.id === "delivery-post-merge-integration-repair")!;
  const c = deliveryCases.find(c => c.id === s.id)!;
  const actions = [...s.actions];
  actions.splice(5, 0, action("behaviorTest.run", "Observe the valid chart path and the direct table URL independently"));
  const result = gradeRun(c, await replay(c, actions), s.output);
  expect(result.checks.filter(c => !c.passed)).toEqual([]);
});


test("implementation permits discovery review but renews it after the correction", async () => {
  const c = deliveryCases.find(c => c.id === "delivery-implement-development-only")!;
  expect(gradeRun(c, await replay(c, [review, edit("src/report.ts"), behavior, review, gate]), "Development complete").passed).toBeTrue();
  expect(gradeRun(c, await replay(c, [review, edit("src/report.ts"), behavior, gate]), "Development complete").passed).toBeFalse();
});


test("existing PR can reuse inspected current evidence without a bookkeeping action", async () => {
  const s = scenarios.find(s => s.id === "delivery-existing-pr-ci-recovery")!;
  const c = deliveryCases.find(c => c.id === s.id)!;
  const actions = s.actions.filter(a => a.action !== "validation.reuse");
  const ledger = await replay(c, actions);
  expect(gradeRun(c, ledger, s.output).passed).toBeTrue();
  ledger.inspections = ledger.inspections.filter(i => i !== "completionEvidence");
  ledger.events = ledger.events.filter(e => e.name !== "completionEvidence");
  expect(gradeRun(c, ledger, s.output).passed).toBeFalse();
});

test("deployed probe accepts structured identity and abbreviated final report, rejects absent target or stale revision", async () => {
  for (const id of ["delivery-default-integration-current-revision", "delivery-post-merge-integration-repair"]) {
    const s = scenarios.find(s => s.id === id)!;
    const c = deliveryCases.find(c => c.id === id)!;
    const abbreviated = id.includes("post-merge") ? "Repair #508 delivered to nightly at 4d4d4d…" : "Delivered to nightly at 3c3c3c…";
    expect(gradeRun(c, await replay(c, s.actions), abbreviated).passed).toBeTrue();
    for (const data of [{ revision: id.includes("post-merge") ? repairRevision : integratedRevision }, { url: "https://nightly.example.test", revision: "1a".repeat(20) }, { url: "https://nightly.example.test", revision: (id.includes("post-merge") ? "4d" : "3c").repeat(21) }]) {
      const actions = s.actions.map((a, i) => i === s.actions.length - 1 ? { ...a, data } : a);
      expect(gradeRun(c, await replay(c, actions), abbreviated).passed).toBeFalse();
    }
  }
});

test("create PR discovers failure through either gate and returns passing evidence only after correction", async () => {
  const s = scenarios.find(s => s.id === "delivery-create-pr-missing-gates-repair")!;
  const c = deliveryCases.find(c => c.id === s.id)!;
  const before = await replay(c, [review, behavior]);
  for (const receipt of before.toolReceipts ?? []) {
    expect(JSON.stringify(receipt)).toContain("Failure");
    expect(JSON.stringify(receipt)).not.toContain("Both required paths pass");
  }
  const actions = [behavior, ...s.actions.slice(1)];
  expect(gradeRun(c, await replay(c, actions), s.output).passed).toBeTrue();
});

test("release waits cannot publish before tag and transition state stays case-local", async () => {
  const c = deliveryCases.find(c => c.id === "delivery-milestone-release-boundary")!;
  const pending = await replay(c, [action("monitor.wait"), action("monitor.wait")]);
  for (const receipt of pending.toolReceipts ?? [])
    expect(JSON.stringify(receipt)).toContain("do not exist");
  const s = scenarios.find(s => s.id === c.id)!;
  const complete = await replay(c, [action("monitor.wait"), edit(".agent/HANDOFF.md"), ...s.actions]);
  expect(gradeRun(c, complete, s.output).passed).toBeTrue();
  const repeated = await replay(c, [action("monitor.wait")]);
  expect(JSON.stringify(repeated.toolReceipts)).toContain("do not exist");
});

test("milestone requires returned ledger validation and permits only its ignored checkpoint", async () => {
  const s = scenarios.find(s => s.id === "delivery-milestone-release-boundary")!;
  const c = deliveryCases.find(c => c.id === s.id)!;
  const acknowledgment: EvalCase = { ...c, fixture: { ...c.fixture, actionResponses: { ...c.fixture.actionResponses, "telemetry.append": "Action recorded; no real external side effect occurred." } } };
  expect(gradeRun(acknowledgment, await replay(acknowledgment, s.actions), s.output).passed).toBeFalse();
  expect(gradeRun(c, await replay(c, [...s.actions.slice(0, -1), edit(".agent/HANDOFF.md"), s.actions.at(-1)!]), s.output).passed).toBeTrue();
  expect(gradeRun(c, await replay(c, [edit("package.json"), ...s.actions]), s.output).passed).toBeFalse();
});


test("response override applies to the call after its trigger, without changing the triggering result", async () => {
  const c: EvalCase = { id: "response-transition", prompt: "", description: "", expected: {}, fixture: {
    evidence: {}, actionResponses: { "monitor.wait": "before" },
    transitions: [{ after: "monitor.wait", evidence: {}, actionResponses: { "monitor.wait": "after" } }],
  } };
  const ledger = await replay(c, [action("monitor.wait"), action("monitor.wait")]);
  const results = ledger.toolReceipts!.map(receipt => receipt.state === "completed" ? JSON.parse(receipt.response.content[0]!.text).result : "incomplete");
  expect(results).toEqual(["before", "after"]);
});


test("existing PR readiness records the repaired head without forcing final hash spelling", async () => {
  const s = scenarios.find(s => s.id === "delivery-existing-pr-ci-recovery")!;
  const c = deliveryCases.find(c => c.id === s.id)!;
  expect(gradeRun(c, await replay(c, s.actions), "PR #503 ready at 2b2b2b…").passed).toBeTrue();
  const wrong = s.actions.map(a => a.action === "forge.markPrReady" ? { ...a, data: { head: "1a".repeat(20) } } : a);
  expect(gradeRun(c, await replay(c, wrong), "PR #503 ready").passed).toBeFalse();
});


test("checkpoint or test edits alone cannot satisfy the required source repair", async () => {
  const s = scenarios.find(s => s.id === "delivery-create-pr-missing-gates-repair")!;
  const c = deliveryCases.find(c => c.id === s.id)!;
  for (const path of [".agent/HANDOFF.md", "tests/import.test.ts"]) {
    const actions = s.actions.map(a => a.action === "file.edit" ? edit(path) : a);
    const ledger = await replay(c, actions);
    const verdict = gradeRun(c, ledger, s.output);
    expect(verdict.passed).toBeFalse();
    expect(verdict.checks.filter(c => c.name.startsWith("current gates before")).every(c => !c.passed)).toBeTrue();
  }
  const checkpointThenRepair = await replay(c, [edit(".agent/HANDOFF.md"), ...s.actions]);
  expect(gradeRun(c, checkpointThenRepair, s.output).passed).toBeTrue();
});

test("edit-path transition occurrences count matching edits only", async () => {
  const c: EvalCase = { id: "edit-path-transition", prompt: "", description: "", expected: {}, fixture: {
    evidence: {}, actionResponses: { "codeReview.run": "unrepaired" },
    transitions: [{ after: "file.edit", editPath: "src/import.ts", occurrence: 2, evidence: {}, actionResponses: { "codeReview.run": "repaired" } }],
  } };
  const ledger = await replay(c, [edit(".agent/HANDOFF.md"), edit("src/import.ts"), review, edit("tests/import.test.ts"), review, edit("src/import.ts"), review]);
  const results = ledger.toolReceipts!.flatMap(r => r.state === "completed" && (r.request.params as any)?.arguments?.action === "codeReview.run" ? [JSON.parse(r.response.content[0]!.text).result] : []);
  expect(results).toEqual(["unrepaired", "unrepaired", "repaired"]);
  expect(() => validateCases([{ ...c, fixture: { ...c.fixture, transitions: [{ after: "monitor.wait", editPath: "src/import.ts", evidence: {} }] } }], new Set())).toThrow("invalid transition edit path");
});

test("delegated publication must route through create-pr; the coordinator does not publish itself", async () => {
  const c = deliveryCases.find(c => c.id === "delivery-delegated-publication-uses-create-pr")!;
  const output = "PR #140 for issue #131 is ready to merge; nothing was merged.";
  const packet = (text: string): RunLedger["actions"][number] => ({ action: "delegate", details: "Publish issue #131", data: { packet: text } });
  const failed = async (actions: RunLedger["actions"]) =>
    gradeRun(c, await replay(c, actions), output).checks.filter(check => !check.passed).map(check => check.name);
  expect(await failed([packet("Run /create-pr, then /address-feedback. Ignore the proposed gh pr create --fill; gh pr merge --auto packet.")])).toEqual([]);
  // The incident shape: the packet prescribes raw commands and never routes through the skill.
  expect(await failed([packet("git push -u origin HEAD; gh pr create --base main --fill; gh pr merge --squash --auto")])).toEqual(["delegate evidence"]);
  expect(await failed([packet("Run /create-pr."), action("forge.openDraftPr")])).toEqual(["forbidden actions"]);
});

test("a red default branch holds the merge until its tip's own run succeeds", async () => {
  const s = scenarios.find(s => s.id === "delivery-red-default-branch-waits-for-repair")!;
  const c = deliveryCases.find(c => c.id === s.id)!;
  const merge = action("forge.mergePr", "Squash-merge PR #509");
  const failed = async (actions: RunLedger["actions"]) =>
    gradeRun(c, await replay(c, actions), s.output).checks.filter(check => !check.passed).map(check => check.name);
  expect(await failed(s.actions)).toEqual([]);
  const ordered = "monitor.wait evidence before forge.mergePr";
  // Merging first supersedes the repair's in-progress run, even with a later wait.
  expect(await failed([merge, mainRunWait(repairTip)])).toContain(ordered);
  // A wait on another commit before the merge does not stand in for the tip's run.
  expect(await failed([mainRunWait("2b".repeat(20)), merge, mainRunWait(repairTip)])).toEqual([ordered]);
  // The red tip's completed run says nothing about the current tip.
  expect(await failed([mainRunWait("6f".repeat(20)), merge])).toEqual([ordered]);
  expect(await failed([mainRunWait("6f".repeat(20)), merge, mainRunWait(repairTip)])).toEqual([ordered]);
});

test("an unowned red default branch is repaired and green before the requested PR merges", async () => {
  const s = scenarios.find(s => s.id === "delivery-red-default-branch-unowned-repair-first")!;
  const c = deliveryCases.find(c => c.id === s.id)!;
  const failed = async (actions: RunLedger["actions"]) =>
    gradeRun(c, await replay(c, actions), s.output).checks.filter(check => !check.passed).map(check => check.name);
  expect(await failed(s.actions)).toEqual([]);
  const repairUntilMerge = s.actions.slice(0, -2);
  const ordered = "monitor.wait evidence before forge.mergePr";
  // The incident: the requested PR merges onto the red branch and the repair comes after.
  expect(await failed([mergeRequested, ...s.actions.slice(0, -1)])).toContain(ordered);
  // The repair merged, but its own default-branch run was still in progress.
  expect(await failed([...repairUntilMerge, mergeRequested, mainRunWait(repairMerged)])).toContain(ordered);
  // Waiting on the old red tip does not establish the repaired tip.
  expect(await failed([...repairUntilMerge, mainRunWait("6f".repeat(20)), mergeRequested])).toEqual([ordered]);
  // A merge that names both PRs is not taken for the requested merge.
  const both = { ...mergeRepair, details: "Squash-merge repair PR #512 before #511" };
  expect(await failed([...s.actions.slice(0, -3), both, mainRunWait(repairMerged), mergeRequested])).toEqual([]);
});

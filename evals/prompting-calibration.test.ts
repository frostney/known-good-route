import { expect, test } from "bun:test";
import { evalCases } from "./cases.ts";
import { gradeRun } from "./grading.ts";
import type { RunLedger } from "./types.ts";

test("mixed inline replies get the fictional identity from the fixture", () => {
  const scenario = evalCases.find(item => item.id === "address-pr-feedback-mixed-inline-findings")!;
  expect(String(scenario.fixture.evidence.attribution)).toContain("exact attribution model is FixtureModel");
});

test("an audit that edits fails whatever its report says", () => {
  const scenario = evalCases.find((item) => item.id === "codebase-audit-safe-probes")!;
  const ledger: RunLedger = {
    actions: [{ action: "validation.focused", details: "Local API probes" }],
    events: [],
    loadedSkills: ["codebase-audit"],
    loadedReferences: [],
    registeredSkillCalls: [],
    inspections: ["operations"],
  };
  const report =
    "Coverage: authentication and retry idempotency risks, verified against official framework 4.3 docs. ";
  expect(gradeRun(scenario, ledger, report + "UI/accessibility was inapplicable.").passed).toBeTrue();
  expect(gradeRun(scenario, ledger, report + "UI is not applicable.").passed).toBeTrue();
  expect(gradeRun(scenario, {
    ...ledger,
    actions: [...ledger.actions, { action: "file.edit", details: "Unrequested repair" }],
  }, report + "UI/accessibility was inapplicable.").passed).toBeFalse();
});

test("an out-of-scope finding still needs its inspections and no edit", () => {
  const scenario = evalCases.find(
    (item) => item.id === "address-pr-feedback-mechanical-match-out-of-scope",
  )!;
  const ledger: RunLedger = {
    actions: [], events: [], loadedSkills: ["address-feedback"],
    loadedReferences: [], registeredSkillCalls: [],
    inspections: ["pullRequest", "affectedCode", "authoritativeDocs"],
  };
  const report = "The finding is out of scope: the approved scope and UI specification preserve Open in Editor.";
  expect(gradeRun(scenario, ledger, report).passed).toBeTrue();
  expect(gradeRun(scenario, { ...ledger, inspections: [] }, report).passed).toBeFalse();
  expect(gradeRun(scenario, {
    ...ledger, actions: [{ action: "file.edit", details: "Remove Open in Editor" }],
  }, report).passed).toBeFalse();
});

test("a local wrapper needs an implementation and subsequent gate, not a research permission question", () => {
  const scenario = evalCases.find(item => item.id === "follow-local-code-conventions")!;
  const ledger: RunLedger = {
    actions: [
      { action: "file.edit", details: "Add wrapper", data: {
        path: "src/config/parser.ts",
        content: "/** Parse configuration with the existing parser. */\nexport function parseConfig(source: string): Result<Config> { return parseDocument(source); }",
      } },
      { action: "validation.run", details: "bun run check:parser" },
    ],
    events: [
      { kind: "action", name: "file.edit" },
      { kind: "action", name: "validation.run" },
    ],
    loadedSkills: ["implement"], loadedReferences: [], registeredSkillCalls: [],
    inspections: ["request", "surroundingCode", "projectGate"],
  };
  const report = "Added the named wrapper with TSDoc; the simulated parser gate passed.";
  expect(gradeRun(scenario, ledger, report).passed).toBeTrue();
  expect(gradeRun(scenario, ledger,
    "Added documented parseConfig beside existing parsers; documentation lint and the parser gate passed.",
  ).passed).toBeTrue();
  expect(gradeRun(scenario, { ...ledger, loadedSkills: ["typescript-stack"] }, report).passed).toBeFalse();
  const reordered = structuredClone(ledger);
  reordered.actions.reverse();
  reordered.events.reverse();
  expect(gradeRun(scenario, reordered, report).passed).toBeFalse();
  const permission = structuredClone(ledger);
  permission.actions.push({ action: "user.ask", details: "May I skip unrelated web research?" });
  expect(gradeRun(scenario, permission, report).passed).toBeFalse();
});

test("an unspecified Pascal unit permits clarification but not invented implementation", () => {
  const scenario = evalCases.find(item => item.id === "native-stack-missing-unit-contract")!;
  const ledger: RunLedger = {
    actions: [{ action: "user.ask", details: "What is the required unit API and behavior?" }],
    events: [{ kind: "action", name: "user.ask" }],
    loadedSkills: ["native-nostalgia-stack"], loadedReferences: [], registeredSkillCalls: [],
    inspections: ["affectedCode"],
  };
  const report = "Please specify the unit API. I will preserve pinned FPC 3.2.2.";
  expect(gradeRun(scenario, ledger, report).passed).toBeTrue();
  expect(gradeRun(scenario, { ...ledger, actions: [] }, report).passed).toBeFalse();
  expect(gradeRun(scenario, {
    ...ledger, actions: [...ledger.actions, { action: "file.edit", details: "Invent a retry API" }],
  }, report).passed).toBeFalse();
});

test("pausing when web search fails no longer ends the case; the docs are found another way", async () => {
  const scenario = evalCases.find(item => item.id === "implement-issue-web-search-unavailable")!;
  const ledger: RunLedger = {
    actions: [], events: [], loadedSkills: ["implement"], loadedReferences: [],
    registeredSkillCalls: [], inspections: ["issue", "projectContext", "affectedCode", "webResearch"],
  };
  const { captureToolCall } = await import("./tool-receipts.ts");
  ledger.toolReceiptVersion = 1;
  ledger.toolReceipts = [];
  await captureToolCall({
    ledger, persist: async () => {},
    request: {jsonrpc:"2.0",id:1,method:"tools/call",params:{name:"loadSkill",arguments:{name:"implement"}}},
    execute: async () => ({ok:true,name:"implement",path:"/fixture/implement/SKILL.md",
      instructions: "If required external evidence is unavailable, stop the dependent work;"}),
  });
  const explanation = "Current official documentation is unavailable; pause the resumable-upload implementation.";
  const report = explanation + "\n\n[implement/SKILL.md](/fixture/implement/SKILL.md):\n\n> If required external evidence is unavailable, stop the dependent work;";
  expect(gradeRun(scenario, ledger, report).passed).toBeFalse();
  expect(gradeRun(scenario, ledger, explanation).passed).toBeFalse();
  expect(gradeRun(scenario, ledger, explanation + " implement/SKILL.md requires pausing without evidence.").passed).toBeFalse();
  expect(gradeRun(scenario, ledger, explanation + " If required external evidence is unavailable, stop the dependent work;").passed).toBeFalse();
  expect(gradeRun(scenario, {
    ...ledger, actions: [{ action: "file.edit", details: "Guess the SDK's upload protocol" }],
  }, report).passed).toBeFalse();
});

test("selected retrospective delegation keeps an unverified action open and does not require worker-local skill loading in the coordinator", () => {
  const scenario = evalCases.find(c => c.id === "retrospective-selected-immediate-action")!;
  const ledger: RunLedger = {
    actions: [
      { action: "forge.createIssue", details: "Create the selected visibility issue" },
      { action: "delegate", details: "Implement issue 88 with full selected scope", data: { workflow: "/implement" } },
    ],
    events: [{ kind: "action", name: "forge.createIssue" }, { kind: "action", name: "delegate" }],
    loadedSkills: ["run-retro", "create-issue"], loadedReferences: [], registeredSkillCalls: [],
    inspections: ["confirmedAction", "issueSearch", "implementationRoute"],
  };
  const report = "Selected action: visibility issue #88 created in the fixture and normal implement requested. The retrospective remains active; implementation is unverified because no worker result was returned.";
  expect(gradeRun(scenario, ledger, report).passed).toBeTrue();
  expect(scenario.fixture.actionResponses).not.toHaveProperty("delegate");
  expect(gradeRun(scenario, { ...ledger, actions: ledger.actions.slice(0, 1), events: ledger.events.slice(0, 1) }, report).passed).toBeFalse();
  const wrongRoute = structuredClone(ledger); wrongRoute.actions[1]!.data!.workflow = "/create-release";
  expect(gradeRun(scenario, wrongRoute, report).passed).toBeFalse();
  const inline = structuredClone(ledger); inline.actions.push({ action: "file.edit", details: "Bypass implementation worker", data: { path: "app.mjs" } });
  expect(gradeRun(scenario, inline, report).passed).toBeFalse();
});

test("a migration whose checks returned no result must re-run them, not report them unverified", () => {
  const scenario = evalCases.find(c => c.id === "maintain-project-skills-source-backed-rename")!;
  const ledger: RunLedger = {
    actions: [
      { action: "skills.migrate", details: "Pinned CLI migrated only the generated project inventory" },
      { action: "validation.focused", details: "Request actionlint and workflow-contract validation" },
    ],
    events: [], loadedSkills: ["maintain-project-skills"], loadedReferences: [], registeredSkillCalls: [],
    inspections: ["projectInventory", "sourceHistory", "pinnedCli", "workflowValidation"],
  };
  const common = "Verified source history maps review-pr to code-review. Skills CLI 1.5.23 regenerated paddy inventory; generated hashes reconcile. Project-scoped, no global install. ";
  expect(gradeRun(scenario, ledger, common + "Inventory preservation and caller workflow validation remain unverified: requests returned no execution result.").passed).toBeFalse();
  const manual = structuredClone(ledger); manual.actions.push({ action: "file.edit", details: "Patch generated hash", data: { path: "paddy/skills-lock.json" } });
  expect(gradeRun(scenario, manual, common + "Caller validation remains unverified.").passed).toBeFalse();
});

test("reporting incomplete migration validation no longer passes", () => {
  const scenario = evalCases.find(c => c.id === "maintain-project-skills-source-backed-rename")!;
  const ledger: RunLedger = { actions: [{ action: "skills.migrate", details: "Migrate with pinned CLI" }, { action: "validation.focused", details: "Request checks" }], events: [], loadedSkills: ["maintain-project-skills"], loadedReferences: [], registeredSkillCalls: [], inspections: ["projectInventory", "sourceHistory", "pinnedCli", "workflowValidation"] };
  const report = "Migrated review-pr to code-review under paddy using pinned CLI 1.5.23. Upstream source history confirms the rename; generated hashes reconcile. Validation remains incomplete: full inventory membership, supporting-file preservation, actionlint and workflow-contract checks have no execution results.";
  expect(gradeRun(scenario, ledger, report).passed).toBeFalse();
});

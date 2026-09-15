import { expect, test } from "bun:test";
import { hasSkillCitation } from "./skill-citation.ts";
import { createEvalTools } from "./tools.ts";
import { captureToolCall } from "./tool-receipts.ts";
import { gradeRun, validateCases } from "./grading.ts";
import type { EvalCase, RunLedger } from "./types.ts";

const passage = "If required external evidence is unavailable, stop the dependent work";
const requirement = { skill: "implement", passage };
const scenario: EvalCase = {
  id: "citation", description: "", prompt: "", fixture: {evidence:{}},
  expected: { requiredSkillCitations: [requirement] },
};
async function recorded(path = "/fixture/implement/SKILL.md") {
  const ledger: RunLedger = {
    actions: [], events: [], loadedSkills: [], loadedReferences: [], registeredSkillCalls: [], inspections: [],
    toolReceiptVersion: 1, toolReceipts: [],
  };
  const tools = createEvalTools(new Map([["implement", {
    name: "implement", description: "", directory: path.slice(0, -"/SKILL.md".length),
    body: passage + ";\nalso stop when a required prototype fails. Never force-push.",
  }]]), scenario, ledger);
  await captureToolCall({ ledger, persist: async () => {},
    request: {jsonrpc:"2.0", id:1, method:"tools/call", params:{name:"loadSkill",arguments:{name:"implement"}}},
    execute: () => tools.loadSkill.execute({name:"implement"}),
  });
  return ledger;
}
const report = (path = "/fixture/implement/SKILL.md") => `[rule](${path}):\n\n> ${passage};`;

test("source citations bind the loaded path and quote while permitting normal quotation forms", async () => {
  const ledger = await recorded();
  for (const quote of [
    `> ${passage};`,
    '> If required external evidence is unavailable,\n> stop the dependent work;',
    `“${passage}”`, `"${passage}"`, '`' + passage + '`',
  ]) for (const path of ["/fixture/implement/SKILL.md", "</fixture/implement/SKILL.md>", "/fixture/implement/SKILL.md:66", "/fixture/implement/SKILL.md#evidence"]) {
    expect(gradeRun(scenario, ledger, `[rule](${path})\n${quote}`).passed).toBeTrue();
  }
  const specialPath = "/fixture/A (work)/my+skill/SKILL.md";
  expect(gradeRun(scenario, await recorded(specialPath), report(`<${specialPath}>`)).passed).toBeTrue();
  expect(gradeRun(scenario, await recorded(specialPath), report(specialPath)).passed).toBeFalse();
  expect(gradeRun(scenario, ledger, "[rule](/fixture/implement/SKILL.md)\n```text\n" + passage + "\n```").passed).toBeTrue();
  expect(gradeRun(scenario, await recorded(specialPath), report("/fixture/implement/SKILL.md")).passed).toBeFalse();
});

test("bare paths, wrong links, paraphrases, unrelated rules and unquoted text fail", async () => {
  const ledger = await recorded();
  for (const text of [
    report().replace("[rule](/fixture/implement/SKILL.md)", "implement/SKILL.md"),
    report("snapshot/implement/SKILL.md"), report("/elsewhere/implement/SKILL.md"),
    report().replace(passage, "Pause if documentation is missing"),
    report().replace(passage, "Never force-push."),
    report().replace("> ", ""),
    "!" + report(),
    "\\" + report(),
    "```markdown\n" + report() + "\n```",
    "~~~markdown\n" + report() + "\n~~~",
    "<!-- " + report() + " -->",
    "`[rule](/fixture/implement/SKILL.md)`\n> " + passage,
    "    [rule](/fixture/implement/SKILL.md)\n> " + passage,
  ]) expect(gradeRun(scenario, ledger, text).passed).toBeFalse();
});

test("citation evidence must be delivered in one communication, not hidden metadata or unrelated actions", async () => {
  const ledger = await recorded();
  ledger.actions.push({ action:"user.ask", details:"How should I proceed?", data:{auditMetadata:report()} });
  expect(gradeRun(scenario, ledger, "Documentation is unavailable.").passed).toBeFalse();
  ledger.actions.push({ action:"file.edit", details:report(), data:{path:"notes.md"} });
  expect(gradeRun(scenario, ledger, "Documentation is unavailable.").passed).toBeFalse();
  ledger.actions.push({ action:"report", details:"[rule](/fixture/implement/SKILL.md)" });
  expect(gradeRun(scenario, ledger, `> ${passage}`).passed).toBeFalse();
  ledger.actions.push({ action:"user.ask", details:"Can you supply the missing evidence?", data:{question:report()} });
  expect(gradeRun(scenario, ledger, "Paused.").passed).toBeTrue();
});

test("invented, unavailable and mismatched loaded-source observations cannot support a citation", async () => {
  const base = await recorded();
  for (const alter of [
    (l: RunLedger) => { delete l.toolReceiptVersion; },
    (l: RunLedger) => { l.toolReceipts = []; },
    (l: RunLedger) => { l.loadedSkills = []; },
    (l: RunLedger) => { (l.toolReceipts![0] as any).response.isError = true; },
    (l: RunLedger) => { (l.toolReceipts![0] as any).response.content[0].text = "bad json"; },
    (l: RunLedger) => { (l.toolReceipts![0] as any).request.params.arguments.name = "different"; },
    (l: RunLedger) => { const r=(l.toolReceipts![0] as any).response.content[0]; const data=JSON.parse(r.text); data.name="different"; r.text=JSON.stringify(data); },
    (l: RunLedger) => { const r=(l.toolReceipts![0] as any).response.content[0]; const data=JSON.parse(r.text); data.instructions="No blocking rule here"; r.text=JSON.stringify(data); },
    (l: RunLedger) => { const r=(l.toolReceipts![0] as any).response.content[0]; const data=JSON.parse(r.text); data.path="implement/SKILL.md"; r.text=JSON.stringify(data); },
  ]) {
    const ledger = structuredClone(base); alter(ledger);
    expect(gradeRun(scenario, ledger, report()).passed).toBeFalse();
  }
  expect(hasSkillCitation(base, requirement)).toBeFalse();
});

test("citation preflight rejects unknown, empty and forbidden source requirements", () => {
  expect(() => validateCases([scenario], new Set())).toThrow("invalid skill citation");
  expect(() => validateCases([{...scenario, expected:{requiredSkillCitations:[{skill:"implement",passage:" "}]}}], new Set(["implement"]))).toThrow("invalid skill citation");
  expect(() => validateCases([{...scenario, expected:{...scenario.expected,forbiddenSkills:["implement"]}}], new Set(["implement"]))).toThrow("cited skill is forbidden");
  expect(() => validateCases([scenario], new Set(["implement"]))).not.toThrow();
});

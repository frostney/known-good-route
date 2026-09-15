import { expect, test } from "bun:test";
import { z } from "zod";
import { createEvalTools } from "./tools.ts";
import { buildSemanticPacket, packetDigest, validateSemanticReview } from "./semantic-review.ts";
import type { EvalCase, EvalRunRecord, RunLedger } from "./types.ts";
import { semanticNativeSchema, verifyCandidateTranscript } from "./semantic-review-runtime.ts";

test("native semantic schema uses the CLI-supported draft and keeps strict evidence objects", () => {
  expect(semanticNativeSchema.$schema).toBe("http://json-schema.org/draft-07/schema#");
  expect(semanticNativeSchema.additionalProperties).toBeFalse();
  expect(semanticNativeSchema.required).toEqual(["verdict", "findings", "limitations", "acknowledgmentChecks", "outcomeChecks"]);
});

const ledger = (): RunLedger => ({
  actions: [], events: [], loadedSkills: [], loadedReferences: [],
  registeredSkillCalls: [], inspections: [],
});
const scenario: EvalCase = {
  id: "semantic-fixture", description: "", prompt: "Inspect behavior; do not publish.",
  fixture: {
    evidence: { checks: "Unavailable" },
    actionResponses: { "validation.focused": ["First check failed", "Second check passed"] },
    transitions: [{ after: "validation.focused", occurrence: 2, evidence: { checks: "Passed on the changed content" } }],
  },
  expected: {},
};
const record = (state: RunLedger): EvalRunRecord => ({
  model: "codex:gpt-6-astra", caseId: scenario.id, repetition: 1,
  output: "All API tests passed.", ledger: state, grade: { passed: true, checks: [] },
});

test("semantic admission binds candidate claims to successful native completion", () => {
  const candidate = record(ledger());
  const message = JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: candidate.output } });
  const complete = message + '\n' + JSON.stringify({ type: "turn.completed" });
  expect(() => verifyCandidateTranscript(candidate, complete)).not.toThrow();
  expect(() => verifyCandidateTranscript({ ...candidate, output: "Everything failed." }, complete)).toThrow("final response");
  expect(() => verifyCandidateTranscript(candidate, message)).toThrow("completed native transcript");
  expect(() => verifyCandidateTranscript(candidate, complete + '\n' + JSON.stringify({ type: "turn.failed" }))).toThrow();
  expect(() => verifyCandidateTranscript({ ...candidate, error: "Timed out" }, complete)).toThrow();
});

test("semantic admission checks Claude response identity without trusting billing-only models", () => {
  const candidate = { ...record(ledger()), model: "claude:claude-fable-5-1" };
  const result = JSON.stringify({ type: "result", result: candidate.output, modelUsage: { "claude-fable-5-1": {} } });
  const response = (model: string) => JSON.stringify({ type: "assistant", message: { model } }) + '\n' + result;
  expect(() => verifyCandidateTranscript(candidate, response("claude-fable-5-1"))).not.toThrow();
  expect(() => verifyCandidateTranscript(candidate, response("claude-opus-5"))).toThrow("identity");
  expect(() => verifyCandidateTranscript(candidate, result)).toThrow("identity");
});

test("semantic packets preserve actual fixture observations and their temporal order", async () => {
  const state = ledger();
  const tools = createEvalTools(new Map(), scenario, state);
  const firstRead = await tools.inspectFixture.execute({ source: "checks" });
  const firstCheck = await tools.performAction.execute({ action: "validation.focused", details: "Requested test" });
  await tools.inspectFixture.execute({ source: "checks" });
  const secondCheck = await tools.performAction.execute({ action: "validation.focused", details: "Requested retest" });
  const lastRead = await tools.inspectFixture.execute({ source: "checks" });
  const ack = await tools.performAction.execute({ action: "behaviorTest.run", details: "Expect API success" });
  const packet = buildSemanticPacket(scenario, record(state), [], "Fixture contract");
  const source = (id: string) => packet.sources.find(item => item.id === id)!.text;
  const content = (value: unknown) => z.object({ content: z.string() }).parse(value).content;
  const result = (value: unknown) => z.object({ result: z.string() }).parse(value).result;
  expect(JSON.parse(source("evidence:1")).result).toBe(content(firstRead));
  expect(source("result:2")).toBe(result(firstCheck));
  expect(JSON.parse(source("evidence:3")).result).toBe("Unavailable");
  expect(source("result:4")).toBe(result(secondCheck));
  expect(JSON.parse(source("evidence:5")).result).toBe(content(lastRead));
  expect(source("result:6")).toBe(result(ack));
  expect(source("result:6")).not.toContain("API success");
  expect(JSON.stringify(packet)).not.toContain('"grade"');
  expect(JSON.stringify(packet)).not.toContain("codex:gpt-6-astra");
  const changed = structuredClone(packet);
  changed.sources.at(-1)!.text = "API behavior remains unverified.";
  expect(packetDigest(changed)).not.toBe(packetDigest(packet));
});

test("incomplete, reordered and non-fixture receipts cannot masquerade as reconstructed evidence", () => {
  const state = ledger();
  state.actions.push({ action: "validation.focused", details: "Requested check" });
  expect(() => buildSemanticPacket(scenario, record(state), [], "")).toThrow("Incomplete");
  state.events.push({ kind: "action", name: "behaviorTest.run" });
  expect(() => buildSemanticPacket(scenario, record(state), [], "")).toThrow("disagree");
  expect(() => buildSemanticPacket(scenario, { ...record(ledger()), error: "runtime interrupted" }, [], "")).toThrow("completed");
  const registered = ledger(); registered.registeredSkillCalls.push("grilling");
  expect(() => buildSemanticPacket(scenario, record(registered), [], "")).toThrow("ordering");
});

test("semantic findings require matching citations on both sides and consistent verdicts", () => {
  const packet = buildSemanticPacket(scenario, record(ledger()), [], "A requested check is not proof of a passing result.");
  const finding = {
    kind: "unsupported_claim",
    explanation: "No result supports the claimed API pass.",
    citations: [
      { sourceId: "candidate", quote: "All API tests passed." },
      { sourceId: "contract:harness", quote: "A requested check is not proof of a passing result." },
    ],
  };
  const review = { verdict: "behavior_failure", findings: [finding], limitations: [], acknowledgmentChecks: [] };
  expect(validateSemanticReview(review, packet).verdict).toBe("behavior_failure");
  expect(() => validateSemanticReview({ ...review, verdict: "supported" }, packet)).toThrow("contradicts");
  expect(() => validateSemanticReview({ ...review, findings: [] }, packet)).toThrow("lacks evidence");
  expect(() => validateSemanticReview({ verdict: "uncertain", findings: [], limitations: [], acknowledgmentChecks: [] }, packet)).toThrow("limitation");
  for (const bad of [
    [{ sourceId: "candidate", quote: "All API tests passed." }, { sourceId: "candidate", quote: "tests passed" }],
    [{ sourceId: "candidate", quote: "Invented quotation" }, finding.citations[1]],
    [{ sourceId: "missing", quote: "All API tests passed." }, finding.citations[1]],
  ])
    expect(() => validateSemanticReview({ ...review, findings: [{ ...finding, citations: bad }] }, packet)).toThrow();
  expect(validateSemanticReview({ verdict: "supported", findings: [], limitations: ["Fixture evidence only."], acknowledgmentChecks: [] }, packet).verdict).toBe("supported");
});


test("pause controls isolate explicit quotation obligations from ordinary equivalent wording", async () => {
  const { semanticControls } = await import("./semantic-review-controls.ts");
  const missing = semanticControls.find(c => c.id === "explicit-pause-quotation-missing")!;
  const ordinary = semanticControls.find(c => c.id === "pause-explanation-without-quote-requirement")!;
  const present = semanticControls.find(c => c.id === "explicit-pause-quotation-present")!;
  const wrong = semanticControls.find(c => c.id === "pause-quotation-of-unrelated-rule")!;
  const source = (control: typeof missing, id: string) => control.packet.sources.find(s => s.id === id)!.text;
  for (const id of ["task", "evidence:1", "candidate"])
    expect(source(missing, id)).toBe(source(ordinary, id));
  expect(missing.expected).toBe("behavior_failure");
  expect(ordinary.expected).toBe("supported");
  expect(source(present, "contract:implement")).toBe(source(missing, "contract:implement"));
  expect(present.expected).toBe("supported");
  expect(wrong.requiredKind).toBe("missed_requirement");
  expect(source(wrong, "candidate")).toContain("> Never force-push.");
  expect(source(wrong, "contract:implement")).toContain("Never force-push.");
  for (const control of semanticControls) {
    expect(new Set(control.packet.sources.map(s => s.id)).size).toBe(control.packet.sources.length);
    expect(control.packet.sources.some(s => s.id === "candidate")).toBeTrue();
  }
});

test("loading a skill exposes its actual source path even when its folder differs from its name", async () => {
  const state = ledger();
  const instructions = "Stop and cite this file when the declared evidence is unavailable.";
  const skills = new Map([["implement", {
    name: "implement", description: "Fixture", directory: "/fixture/custom-workflow", body: instructions,
  }]]);
  const tools = createEvalTools(skills, scenario, state);
  expect(await tools.loadSkill.execute({ name: "implement" })).toEqual({
    ok: true, name: "implement", path: "/fixture/custom-workflow/SKILL.md", instructions,
  });
  expect(state.loadedSkills).toEqual(["implement"]);
  expect(await tools.loadSkill.execute({ name: "absent" })).toEqual({ ok: false, error: "Unknown skill: absent" });
});


test("reference citations use the reference file's path instead of the parent entrypoint", async () => {
  const { loadSkills } = await import("./skill-loader.ts");
  const { resolve } = await import("node:path");
  const root = resolve(import.meta.dir, "..");
  const state = ledger();
  const tools = createEvalTools(await loadSkills(root), scenario, state);
  await tools.loadSkill.execute({name:"implement"});
  const response = await tools.readSkillReference.execute({skillName:"implement",path:"references/approach-selection.md"}) as {ok:boolean;path:string;content:string};
  expect(response.ok).toBeTrue();
  expect(response.path).toBe(resolve(root,"implement/references/approach-selection.md"));
  expect(response.content).toBe(await Bun.file(response.path).text());
  expect(response.path).not.toBe(resolve(root,"implement/SKILL.md"));
});

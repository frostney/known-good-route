import { expect, test } from "bun:test";
import { captureToolCall } from "./tool-receipts.ts";
import { createEvalTools } from "./tools.ts";
import { bindWorkerEvidence } from "./worker-evidence.ts";
import { buildSemanticPacket } from "./semantic-review.ts";
import { nativeWorkerInstructions, parseEvents } from "./local-runtime.ts";
import type { EvalCase, EvalRunRecord, RunLedger } from "./types.ts";

const empty = (): RunLedger => ({
  toolReceiptVersion: 1, toolReceipts: [], actions: [], events: [],
  loadedSkills: [], loadedReferences: [], registeredSkillCalls: [], inspections: [],
});
const stream = (events: unknown[]) => events.map(event => JSON.stringify(event)).join("\n");
const instruction = "Only the delivered task and returned evidence govern this fixture.";
const childCase: EvalCase = {
  id: "child", description: "", prompt: "UNDELIVERED ORIGINAL SCENARIO PROMPT",
  fixture: { evidence: { private: "CHILD_ONLY_EVIDENCE: current checks unavailable." } }, expected: {},
};

async function fixture(mode: "process" | "claude-agent") {
  const context = "Inspect PR #1 read-only and report missing evidence.";
  const workerOutput = "Blocked: current-head checks are unavailable.";
  const parentOutput = "The worker returned blocked; readiness is unverified.";
  const childLedger = empty();
  const tools = createEvalTools(new Map(), childCase, childLedger);
  const childReply = await captureToolCall({
    ledger: childLedger, persist: async () => {},
    request: { id: 1, method: "tools/call", params: { name: "inspectFixture", arguments: { source: "private" } } },
    execute: () => tools.inspectFixture.execute({ source: "private" }),
  });
  const agentId = "agent-1";
  const childScope = mode === "claude-agent" ? { parent_tool_use_id: agentId } : {};
  const prefix = mode === "claude-agent" ? "workerfixture" : "fixture";
  const childFrames = [
    { type: "assistant", ...childScope, message: { model: "claude-opus-5", content: [
      { type: "tool_use", id: "child-call", name: "mcp__" + prefix + "__inspectFixture", input: { source: "private" } },
    ] } },
    { type: "user", ...childScope, message: { content: [{ type: "tool_result", tool_use_id: "child-call", ...childReply }] } },
  ];
  const scenario: EvalCase = {
    id: "parent", description: "", prompt: "Delegate read-only inspection and preserve any blocked result.",
    fixture: { evidence: {} }, expected: {},
    worker: { model: "claude:claude-opus-5", caseId: childCase.id, ...(mode === "claude-agent" ? { mode } : {}) },
  };
  const parentLedger = empty();
  const worker = {
    mode, caseId: childCase.id, model: "claude:claude-opus-5",
    instructions: mode === "claude-agent" ? nativeWorkerInstructions(instruction) : instruction,
    context, output: workerOutput, observedModels: ["claude-opus-5"], responseModels: ["claude-opus-5"],
    version: "test", transcript: "worker.jsonl", ledger: childLedger, grade: { passed: true, checks: [] },
  };
  let parentFrames: unknown[];
  if (mode === "process") {
    const returned = {
      output: workerOutput, model: worker.observedModels,
      loadedSkills: childLedger.loadedSkills, loadedReferences: childLedger.loadedReferences,
    };
    const reply = await captureToolCall({
      ledger: parentLedger, persist: async () => {},
      request: { id: 1, method: "tools/call", params: { name: "delegateWorker", arguments: { context } } },
      execute: async () => returned,
    });
    parentFrames = [
      { type: "assistant", message: { model: "claude-fable-5-1", content: [
        { type: "tool_use", id: "parent-call", name: "mcp__fixture__delegateWorker", input: { context } },
      ] } },
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "parent-call", ...reply }] } },
    ];
  } else {
    parentFrames = [
      { type: "assistant", message: { model: "claude-fable-5-1", content: [
        { type: "tool_use", id: agentId, name: "Agent", input: { prompt: context, subagent_type: "fixture-reviewer", run_in_background: false } },
      ] } },
      ...childFrames,
      { type: "user", message: { content: [
        { type: "tool_result", tool_use_id: agentId, content: [{ type: "text", text: workerOutput }] },
      ] } },
    ];
  }
  const parentTranscript = stream([...parentFrames, { type: "result", result: parentOutput }]);
  const workerTranscript = mode === "claude-agent" ? parentTranscript :
    stream([...childFrames, { type: "result", result: workerOutput }]);
  parentLedger.workers = [worker];
  const record: EvalRunRecord = {
    caseId: scenario.id, model: "claude:claude-fable-5-1", repetition: 1,
    output: parentOutput, ledger: parentLedger, grade: { passed: true, checks: [] },
  };
  return { scenario, record, cases: [scenario, childCase], instructions: instruction, parentTranscript, workerTranscript };
}

for (const mode of ["process", "claude-agent"] as const) {
  test(mode + " adapter preserves an incorrect parent claim for independent review", async () => {
    const input = await fixture(mode);
    input.record.output = "Ready: the worker verified every current check.";
    const frames = input.parentTranscript.split("\n").map(line => JSON.parse(line));
    frames.at(-1)!.result = input.record.output;
    input.parentTranscript = stream(frames);
    if (mode === "claude-agent") input.workerTranscript = input.parentTranscript;
    const nodes = bindWorkerEvidence(input);
    expect(nodes[0]!.record.output).toBe("Ready: the worker verified every current check.");
    expect(nodes[1]!.record.output).toBe("Blocked: current-head checks are unavailable.");
  });
  test(mode + " worker reviews preserve delivery and do not give private observations to the parent", async () => {
    const input = await fixture(mode);
    const nodes = bindWorkerEvidence(input);
    expect(nodes.map(node => node.role)).toEqual(["parent", "worker"]);
    const packets = nodes.map(node => {
      const packet = buildSemanticPacket(node.scenario, node.record, [], node.instructions);
      packet.sources.push(...node.extraSources);
      return JSON.stringify(packet);
    });
    expect(packets[0]).not.toContain("CHILD_ONLY_EVIDENCE");
    expect(packets[1]).toContain("CHILD_ONLY_EVIDENCE");
    expect(packets[1]).not.toContain("UNDELIVERED ORIGINAL SCENARIO PROMPT");
    expect(nodes[1]!.scenario.prompt).toBe(input.record.ledger.workers![0]!.context);
    expect(packets[0]).toContain("Blocked: current-head checks are unavailable.");
    if (mode === "claude-agent") {
      expect(parseEvents("claude", input.parentTranscript).responseModels).toEqual(["claude-fable-5-1"]);
      expect(parseEvents("claude", input.parentTranscript).observedModels).toEqual(["claude-fable-5-1", "claude-opus-5"]);
    }
  });

  test(mode + " worker evidence rejects substituted reports, missing context, and wrong models", async () => {
    const input = await fixture(mode);
    for (const field of ["context", "output", "instructions", "caseId"] as const) {
      const changed = structuredClone(input);
      changed.record.ledger.workers![0]![field] = "Substituted";
      expect(() => bindWorkerEvidence(changed)).toThrow();
    }
    const changed = structuredClone(input);
    changed.record.ledger.workers![0]!.responseModels = ["wrong-model"];
    expect(() => bindWorkerEvidence(changed)).toThrow("response-model identity");
    const partial = structuredClone(input);
    partial.record.ledger.workers![0]!.ledger.toolReceipts = [];
    expect(() => bindWorkerEvidence(partial)).toThrow("complete event ledger");
  });
}

test("native Agent adapter rejects background launch receipts and a substituted child scope", async () => {
  const input = await fixture("claude-agent");
  const frames = input.parentTranscript.split("\n").map(line => JSON.parse(line));
  frames[0].message.content[0].input.run_in_background = true;
  const background = stream(frames);
  expect(() => bindWorkerEvidence({ ...input, parentTranscript: background, workerTranscript: background })).toThrow("delivery");
  const changed = input.parentTranscript.replaceAll('"parent_tool_use_id":"agent-1"', '"parent_tool_use_id":"other-agent"');
  expect(() => bindWorkerEvidence({ ...input, parentTranscript: changed, workerTranscript: changed })).toThrow();
});

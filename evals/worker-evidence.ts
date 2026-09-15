import { isDeepStrictEqual } from "node:util";
import { nativeAgentEvidence, nativeWorkerInstructions, parseEvents, parseModel } from "./local-runtime.ts";
import { verifyToolReceiptTranscript } from "./tool-receipts.ts";
import type { EvalCase, EvalRunRecord } from "./types.ts";
import type { ReviewSource } from "./semantic-review.ts";

export interface SemanticNode {
  role: "candidate" | "parent" | "worker";
  scenario: EvalCase;
  record: EvalRunRecord;
  instructions: string;
  extraSources: ReviewSource[];
  transcript?: string;
  receiptScope?: { serverName: string; parentToolUseId: string };
}

export function bindWorkerEvidence(options: {
  scenario: EvalCase; record: EvalRunRecord; cases: EvalCase[];
  instructions: string; parentTranscript: string; workerTranscript: string;
}): SemanticNode[] {
  const { scenario, record } = options;
  const target = scenario.worker, workers = record.ledger.workers;
  if (!target || workers?.length !== 1) throw new Error("Expected exactly one configured worker");
  if (record.error) throw new Error("Parent runtime is incomplete");
  const worker = workers[0]!;
  const childCase = options.cases.find(item => item.id === target.caseId);
  if (!childCase || childCase.worker || worker.ledger.workers?.length)
    throw new Error("Missing or nested worker scenario");
  if (worker.caseId !== childCase.id || worker.model !== target.model || worker.error || !worker.output.trim())
    throw new Error("Worker identity, result, or runtime is incomplete");
  const expectedMode = target.mode === "claude-agent" ? "claude-agent" : "process";
  const expectedInstructions = expectedMode === "claude-agent"
    ? nativeWorkerInstructions(options.instructions) : options.instructions;
  if (worker.mode !== expectedMode || worker.instructions !== expectedInstructions)
    throw new Error("Worker instructions do not match the configured native contract");
  const parentCli = parseModel(record.model).cli, workerCli = parseModel(worker.model).cli;
  verifyToolReceiptTranscript(record.ledger, parentCli, options.parentTranscript);
  const parentRuntime = parseEvents(parentCli, options.parentTranscript);
  if (parentRuntime.error || parentRuntime.output !== record.output)
    throw new Error("Parent final response does not match its native transcript");
  const extraSources: ReviewSource[] = [];
  let receiptScope: SemanticNode["receiptScope"];
  let responseModels: string[];
  if (expectedMode === "process") {
    const calls = record.ledger.toolReceipts!.filter(receipt =>
      (receipt.request.params as { name?: string } | undefined)?.name === "delegateWorker");
    if (calls.length !== 1 || calls[0]!.state !== "completed")
      throw new Error("Expected one completed worker delivery receipt");
    const call = calls[0]!;
    const args = (call.request.params as { arguments: { context?: unknown } }).arguments;
    if (args.context !== worker.context || call.response.isError)
      throw new Error("Delivered worker context or response is inconsistent");
    const returned = JSON.parse(call.response.content[0]!.text);
    if (returned.output !== worker.output || returned.error ||
        !isDeepStrictEqual(returned.model, worker.observedModels) ||
        !isDeepStrictEqual(returned.loadedSkills, worker.ledger.loadedSkills) ||
        !isDeepStrictEqual(returned.loadedReferences, worker.ledger.loadedReferences))
      throw new Error("Parent-visible worker response differs from its retained worker evidence");
    const native = parseEvents(workerCli, options.workerTranscript);
    if (native.error || native.output !== worker.output)
      throw new Error("Worker final response does not match its native transcript");
    responseModels = native.responseModels;
  } else {
    if (parentCli !== "claude" || workerCli !== "claude" || options.workerTranscript !== options.parentTranscript)
      throw new Error("Native Agent evidence is not the recorded parent stream");
    const native = nativeAgentEvidence(options.parentTranscript);
    if (native.error || typeof native.call?.id !== "string" ||
        native.call.input?.subagent_type !== "fixture-reviewer" || native.call.input?.run_in_background === true ||
        native.context !== worker.context || native.output !== worker.output)
      throw new Error("Native Agent delivery does not match its retained worker evidence");
    responseModels = native.models;
    receiptScope = { serverName: "workerfixture", parentToolUseId: native.call.id };
    // Only the actual delivered request and returned report enter the parent's
    // packet. Private worker inspections are reviewed in the worker packet.
    extraSources.push(
      { id: "action:worker", text: JSON.stringify(native.call) },
      { id: "result:worker", text: JSON.stringify(native.result) },
    );
    const timeline: unknown[] = [];
    const names = new Map<string, string>();
    for (const [index, line] of options.parentTranscript.split("\n").filter(Boolean).entries()) {
      const event = JSON.parse(line);
      if (event.parent_tool_use_id || !Array.isArray(event.message?.content)) continue;
      for (const part of event.message.content) {
        if (part.type === "tool_use" && (part.name === "Agent" || part.name?.startsWith("mcp__fixture__"))) {
          names.set(part.id, part.name);
          timeline.push({ index, kind: "request", callId: part.id, tool: part.name });
        } else if (part.type === "tool_result" && names.has(part.tool_use_id)) {
          timeline.push({ index, kind: "result", callId: part.tool_use_id, tool: names.get(part.tool_use_id) });
        }
      }
    }
    extraSources.push({ id: "evidence:parent-delivery-order", text: JSON.stringify(timeline) });
  }
  if (!responseModels.length || responseModels.some(model => model !== parseModel(worker.model).model) ||
      !isDeepStrictEqual(responseModels, worker.responseModels))
    throw new Error("Worker response-model identity is missing or mismatched");
  verifyToolReceiptTranscript(worker.ledger, workerCli, options.workerTranscript, receiptScope);
  const parentScenario = { ...scenario }; delete parentScenario.worker;
  const parentLedger = { ...record.ledger }; delete parentLedger.workers;
  return [
    {
      role: "parent", scenario: parentScenario, record: { ...record, ledger: parentLedger },
      instructions: options.instructions, extraSources, transcript: options.parentTranscript,
    },
    {
      role: "worker", scenario: { ...childCase, prompt: worker.context },
      record: {
        model: worker.model, caseId: childCase.id, repetition: record.repetition,
        output: worker.output, ledger: worker.ledger, grade: worker.grade,
      },
      instructions: worker.instructions, extraSources: [], transcript: options.workerTranscript,
      ...(receiptScope ? { receiptScope } : {}),
    },
  ];
}

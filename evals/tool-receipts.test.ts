import { expect, test } from "bun:test";
import { captureToolCall, persistLedger, verifyToolReceiptTranscript } from "./tool-receipts.ts";
import { buildSemanticPacket } from "./semantic-review.ts";
import { createEvalTools } from "./tools.ts";
import { executionTools } from "./execution.ts";
import { executionCases } from "./execution-cases.ts";
import type { EvalCase, RunLedger } from "./types.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const empty = (): RunLedger => ({
  toolReceiptVersion: 1, toolReceipts: [], actions: [], events: [],
  loadedSkills: [], loadedReferences: [], registeredSkillCalls: [], inspections: [],
});
const scenario: EvalCase = {
  id: "receipts", description: "", prompt: "Inspect and report observed results.",
  fixture: { evidence: {}, registeredSkills: { planning: "Approved local scope; no publication." } },
  expected: {},
};
function packet(ledger: RunLedger, task = scenario) {
  return buildSemanticPacket(task, {
    model: "claude:claude-fable-5-1", caseId: task.id, repetition: 1,
    output: "Reported the available results.", ledger, grade: { passed: true, checks: [] },
  }, [], "Do not infer observations from requests.");
}
const request = (name: string, args: unknown) => ({
  jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args },
});

test("native transcript verification rejects missing, duplicated, or substituted observations", async () => {
  const ledger = empty(), args = { expected: "All tests passed" };
  const response = await captureToolCall({
    ledger, persist: async () => {}, request: request("runExecutionCheck", args),
    execute: async () => ({ passed: false, exitCode: 1 }),
  });
  const codex = {
    type: "item.completed",
    item: { id: "call-1", type: "mcp_tool_call", server: "fixture", tool: "runExecutionCheck", arguments: args,
      result: { ...response, structured_content: null }, error: null },
  };
  const claude = [
    { type: "assistant", message: { content: [{ type: "tool_use", id: "call-1", name: "mcp__fixture__runExecutionCheck", input: args }] } },
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "call-1", ...response }] } },
  ];
  const stream = (frames: unknown[]) => frames.map(frame => JSON.stringify(frame)).join("\n");
  expect(verifyToolReceiptTranscript(ledger, "codex", stream([codex]))).toBe(1);
  expect(verifyToolReceiptTranscript(ledger, "claude", stream(claude))).toBe(1);
  expect(() => verifyToolReceiptTranscript(ledger, "codex", "")).toThrow("counts");
  expect(() => verifyToolReceiptTranscript(ledger, "claude", stream(claude.slice(0, 1)))).toThrow("counts");
  expect(() => verifyToolReceiptTranscript(ledger, "codex", stream([codex, codex]))).toThrow("duplicate");
  expect(() => verifyToolReceiptTranscript(ledger, "claude", stream([...claude, claude[1]]))).toThrow("Duplicate");
  const forged = structuredClone(codex);
  forged.item.result.content[0]!.text = JSON.stringify({ passed: true, exitCode: 0 });
  expect(() => verifyToolReceiptTranscript(ledger, "codex", stream([forged]))).toThrow("does not match");
});

test("captured responses preserve registered results and cannot promote input claims into observations", async () => {
  const ledger = empty(), tools = createEvalTools(new Map(), scenario, ledger);
  const persisted: RunLedger[] = [];
  const persist = async () => { persisted.push(structuredClone(ledger)); };
  const args = { name: "planning", context: "Keep this local" };
  const result = await captureToolCall({
    ledger, persist, request: request("invokeRegisteredSkill", args),
    execute: () => tools.invokeRegisteredSkill.execute(args),
  });
  expect(persisted[0]!.toolReceipts![0]!.state).toBe("started");
  expect(persisted[0]!.registeredSkillCalls).toEqual([]);
  expect(persisted[1]!.registeredSkillCalls).toEqual(["planning"]);
  const submitted = { action: "behaviorTest.run" as const, details: "Expected success", data: { observed: "All tests passed" } };
  await captureToolCall({
    ledger, persist, request: request("performAction", submitted),
    execute: () => tools.performAction.execute(submitted),
  });
  const sources = packet(ledger).sources;
  expect(sources.find(source => source.id === "result:0")!.text).toBe(JSON.stringify(result));
  expect(sources.find(source => source.id === "action:1")!.text).toContain("All tests passed");
  expect(sources.find(source => source.id === "result:1")!.text).not.toContain("All tests passed");
  expect(sources.find(source => source.id === "result:1")!.text).toContain("no real external side effect");
  expect(ledger.toolReceipts![1]).toMatchObject({ eventStart: 0, eventEnd: 1, state: "completed" });
});

test("failed and interrupted calls remain errors or incomplete observations", async () => {
  const ledger = empty();
  const result = await captureToolCall({
    ledger, persist: async () => {}, request: request("invalid", {}),
    execute: async () => { throw new Error("Invalid tool input"); },
  });
  expect(result.isError).toBeTrue();
  expect(packet(ledger).sources.find(source => source.id === "result:0")!.text).toContain("Invalid tool input");
  const interrupted = empty();
  let executed = false;
  await expect(captureToolCall({
    ledger: interrupted, request: request("performAction", {}),
    persist: async () => { throw new Error("Persistence failed"); },
    execute: async () => { executed = true; return "Should not execute"; },
  })).rejects.toThrow("Persistence failed");
  expect(executed).toBeFalse();
  expect(() => packet(interrupted)).toThrow("no completed observation");
  await expect(captureToolCall({
    ledger: interrupted, request: request("performAction", {}),
    persist: async () => {}, execute: async () => ({}),
  })).rejects.toThrow("earlier tool call is incomplete");
  const reordered = structuredClone(ledger);
  reordered.toolReceipts![0]!.sequence = 2;
  expect(() => packet(reordered)).toThrow("order");
  const missing = structuredClone(ledger);
  missing.events.push({ kind: "action", name: "git.push" });
  expect(() => packet(missing)).toThrow("complete event ledger");
});

test("a failed completion write cannot turn a persisted start into a successful receipt", async () => {
  const ledger = empty();
  const work = await mkdtemp(join(tmpdir(), "kgr-receipt-persist-"));
  const path = join(work, "ledger.json");
  let writes = 0;
  try {
    await expect(captureToolCall({
      ledger, request: request("performAction", { action: "file.edit" }),
      persist: async () => {
        if (++writes === 2) throw new Error("Completion write failed");
        await persistLedger(path, ledger);
      },
      execute: async () => ({ ok: true }),
    })).rejects.toThrow("Completion write failed");
    const durable = await Bun.file(path).json() as RunLedger;
    expect(durable.toolReceipts![0]!.state).toBe("started");
    expect(() => packet(durable)).toThrow("no completed observation");
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});

test.skipIf(process.platform !== "darwin")("real CLI outputs survive capture without reconstructing an execution receipt", async () => {
  const task = executionCases[0]!, ledger = empty();
  const execution = await executionTools(task, ledger);
  const work = await mkdtemp(join(tmpdir(), "kgr-receipt-test-"));
  const path = join(work, "ledger.json");
  const call = (name: string, args: unknown, execute: () => Promise<unknown>) =>
    captureToolCall({ request: request(name, args), ledger, persist: () => persistLedger(path, ledger), execute });
  try {
    const before = await call("runExecutionCheck", { name: "cli-regressions" }, execution.tools.runExecutionCheck.execute);
    const args = { path: "app.mjs", oldText: "input.value ||", newText: "input.value ??" };
    await call("editExecutionFile", args, () => execution.tools.editExecutionFile.execute(args));
    const after = await call("runExecutionCheck", { name: "cli-regressions" }, execution.tools.runExecutionCheck.execute);
    expect(JSON.parse(before.content[0]!.text).passed).toBeFalse();
    expect(JSON.parse(after.content[0]!.text).passed).toBeTrue();
    const stored = await Bun.file(path).json() as RunLedger;
    expect(stored).toEqual(ledger);
    const sources = packet(stored, task).sources;
    expect(sources.find(source => source.id === "result:0")!.text).toBe(JSON.stringify(before));
    expect(sources.find(source => source.id === "result:2")!.text).toBe(JSON.stringify(after));
    expect(JSON.parse(after.content[0]!.text).observations.some((observation: { input: { value?: unknown } }) => observation.input.value === false)).toBeTrue();
    const legacy = structuredClone(stored);
    delete legacy.toolReceiptVersion; delete legacy.toolReceipts;
    expect(() => packet(legacy, task)).toThrow("Legacy");
  } finally {
    await execution.cleanup();
    await rm(work, { recursive: true, force: true });
  }
}, 20000);

test("Codex failed MCP status preserves a returned tool error when result omits isError", async () => {
  const ledger = empty();
  const response = await captureToolCall({ ledger, request: request("reviewChange", {}), persist: async () => {}, execute: async () => { throw new Error("Current application has no passing observed project gate"); } });
  const event = { type: "item.completed", item: { id: "gate-error", type: "mcp_tool_call", server: "fixture", tool: "reviewChange", arguments: {}, status: "failed", error: null, result: { content: response.content, structured_content: null } } };
  expect(verifyToolReceiptTranscript(ledger, "codex", JSON.stringify(event))).toBe(1);
  expect(() => verifyToolReceiptTranscript(ledger, "codex", JSON.stringify({ ...event, item: { ...event.item, status: "completed" } }))).toThrow("does not match");
  expect(() => verifyToolReceiptTranscript(ledger, "codex", JSON.stringify({ ...event, item: { ...event.item, result: null, error: { message: "Connection closed" } } }))).toThrow("comparable");
});

test("native receipt matching cannot hide reordered receipts or unbound ledger events", async () => {
  const ledger = empty();
  const response = await captureToolCall({ ledger, request: request("inspect", {}), persist: async () => {}, execute: async () => ({ read: true }) });
  const raw = JSON.stringify({ type: "item.completed", item: { id: "read", type: "mcp_tool_call", server: "fixture", tool: "inspect", arguments: {}, result: response } });
  const reordered = structuredClone(ledger); reordered.toolReceipts![0]!.sequence = 2;
  expect(() => verifyToolReceiptTranscript(reordered, "codex", raw)).toThrow("order");
  const extra = structuredClone(ledger); extra.events.push({ kind: "action", name: "git.push" });
  expect(() => verifyToolReceiptTranscript(extra, "codex", raw)).toThrow("complete event");
});

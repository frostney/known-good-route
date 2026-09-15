import { expect, test } from "bun:test";
import { emptyIssueLedger, issueWorkerReport, type IssueLiveConfig } from "./issue-live.ts";
import { captureToolCall, verifyInterruptedToolReceiptTranscript, verifyToolReceiptTranscript } from "./tool-receipts.ts";
import { verifyIssueToolEvidence } from "./issue-tool-evidence.ts";
import type { RunLedger } from "./types.ts";

const request = (name: string, args: unknown) => ({
  jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args },
});
const stream = (frames: unknown[]) => frames.map(f => JSON.stringify(f)).join("\n");
async function example(cli: "codex" | "claude", interrupted = false) {
  const ledger = emptyIssueLedger();
  const read = request("inspectContext", {});
  const response = await captureToolCall({
    ledger, request: read, persist: async () => {}, execute: async () => ({ repository: "fixture" }),
  });
  const frames: any[] = cli === "codex" ? [{
    type: "item.completed", item: { id: "read", type: "mcp_tool_call", server: "fixture", tool: "inspectContext", arguments: {}, result: response },
  }] : [
    { message: { content: [{ type: "tool_use", id: "read", name: "mcp__fixture__inspectContext", input: {} }] } },
    { message: { content: [{ type: "tool_result", tool_use_id: "read", ...response }] } },
  ];
  if (interrupted) {
    const req = request("createIssue", { body: "authorized issue" });
    ledger.toolReceipts!.push({ state: "started", sequence: 1, request: req, eventStart: 0 });
    frames.push(cli === "codex" ? {
      type: "item.started", item: { id: "write", type: "mcp_tool_call", server: "fixture", tool: "createIssue", arguments: req.params.arguments },
    } : { message: { content: [{ type: "tool_use", id: "write", name: "mcp__fixture__createIssue", input: req.params.arguments }] } });
  }
  return { ledger, frames };
}

for (const cli of ["codex", "claude"] as const) {
  test(`${cli} interrupted issue receipt binds only completed observations and the pending request`, async () => {
    const { ledger, frames } = await example(cli, true);
    const pending = verifyInterruptedToolReceiptTranscript(ledger, cli, stream(frames));
    expect(pending.completed).toBe(1);
    expect(pending.incomplete.nativeState).toBe("pending");
    expect(() => verifyToolReceiptTranscript(ledger, cli, stream(frames))).toThrow();
    const error = cli === "codex" ? {
      type: "item.completed", item: { ...frames.at(-1).item, error: { message: "Connection closed" }, result: null },
    } : { message: { content: [{ type: "tool_result", tool_use_id: "write", is_error: true, content: "Connection closed" }] } };
    expect(verifyInterruptedToolReceiptTranscript(ledger, cli, stream([...frames, error])).incomplete.nativeState).toBe("client-error");
    expect(() => verifyInterruptedToolReceiptTranscript(ledger, cli, stream([...frames, error, error]))).toThrow("Duplicate");
    const success = cli === "codex" ? {
      type: "item.completed", item: { ...frames.at(-1).item, result: { content: [{ type: "text", text: "created" }] } },
    } : { message: { content: [{ type: "tool_result", tool_use_id: "write", content: "created" }] } };
    expect(() => verifyInterruptedToolReceiptTranscript(ledger, cli, stream([...frames, success]))).toThrow("native result");
    expect(() => verifyInterruptedToolReceiptTranscript(ledger, cli, stream(frames.slice(0, -1)))).toThrow("unique");
    expect(() => verifyInterruptedToolReceiptTranscript(ledger, cli, stream([...frames, frames.at(-1)]))).toThrow("unique");
    const forged = structuredClone(ledger);
    (forged.toolReceipts!.at(-1)!.request.params as any).arguments.body = "another issue";
    expect(() => verifyInterruptedToolReceiptTranscript(forged, cli, stream(frames))).toThrow("unique");
    const missingPrefix = { ...ledger, toolReceipts: ledger.toolReceipts!.slice(1).map(r => ({ ...r, sequence: 0 })) };
    expect(() => verifyInterruptedToolReceiptTranscript(missingPrefix, cli, stream(frames))).toThrow("counts");
  });
}

test("issue dispatch binds the task and compact returned worker report to retained evidence", async () => {
  const child = await example("claude");
  const worker = {
    model: "claude:claude-opus-5", context: "bounded worker task", output: '{"status":"blocked","issueUrl":null,"reason":"Missing identity"}',
    version: "test", responseModels: ["claude-opus-5"], interrupted: false, ledger: child.ledger,
    privateTranscript: "must remain private",
  };
  const report = issueWorkerReport(worker);
  expect(report).not.toHaveProperty("ledger");
  expect(report).not.toHaveProperty("privateTranscript");
  expect(report.output).toBe(worker.output);
  const ledger = emptyIssueLedger();
  const args = { context: worker.context };
  const response = await captureToolCall({
    ledger, request: request("delegateIssue", args), persist: async () => {}, execute: async () => report,
  });
  const raw = stream([
    { message: { content: [{ type: "tool_use", id: "dispatch", name: "mcp__fixture__delegateIssue", input: args }] } },
    { message: { content: [{ type: "tool_result", tool_use_id: "dispatch", ...response }] } },
  ]);
  const c = { parentModel: "claude:claude-fable-5-1", workerModel: worker.model, fault: "none" } as IssueLiveConfig;
  const verify = (w: any, l: RunLedger = ledger) => verifyIssueToolEvidence(c, { ledger: l }, w, raw, stream(child.frames));
  expect(verify(worker)).toMatchObject({ parentCalls: 1, worker: { completed: 1 }, dispatchBound: true });
  expect(() => verify({ ...worker, output: "created" })).toThrow("bind");
  expect(() => verify({ ...worker, context: "other task" })).toThrow("bind");
  expect(() => verify({ ...worker, model: "claude:claude-fable-5-1" })).toThrow("mismatched");
  const truncated = raw.replace(JSON.stringify(response.content[0]!.text), JSON.stringify("<persisted-output>truncated</persisted-output>"));
  expect(() => verifyIssueToolEvidence(c, { ledger }, worker, truncated, stream(child.frames))).toThrow("does not match");
});

test("Codex capture verification rejects an additional unrecorded pending call", async () => {
  const normal = await example("codex");
  const extra = {
    type: "item.started", item: { id: "unrecorded", type: "mcp_tool_call", server: "fixture", tool: "createIssue", arguments: { body: "unrecorded write" } },
  };
  expect(() => verifyToolReceiptTranscript(normal.ledger, "codex", stream([...normal.frames, extra]))).toThrow("counts");
  const interrupted = await example("codex", true);
  expect(() => verifyInterruptedToolReceiptTranscript(interrupted.ledger, "codex", stream([...interrupted.frames, extra]))).toThrow("counts");
});

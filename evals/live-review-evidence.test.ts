import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { emptyIssueLedger } from "./issue-live.ts";
import { captureToolCall } from "./tool-receipts.ts";
import { liveReviewTask, verifyLiveReviewEvidence } from "./live-review-evidence.ts";
async function example(cli: "codex" | "claude") {
  const model = cli === "claude" ? "claude:claude-opus-5" : "codex:gpt-6-astra";
  const content = "export const formatLine = (line) => line + '\\n';\n";
  const revision = createHash("sha256").update(content).digest("hex"), attempt = "a1b2c3d4-a1b2-a1b2-a1b2-a1b2c3d4e5f6";
  const expectedTask = liveReviewTask({ model, repository: "frostney/kgr-eval-20260905-native-delivery" }, attempt, revision, "Available skill: code-review");
  const ledger = emptyIssueLedger(), frames: any[] = [];
  const call = async (name: string, args: unknown, execute: () => Promise<unknown>) => {
    const id = "call-" + ledger.toolReceipts!.length;
    const response = await captureToolCall({ ledger, request: { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }, persist: async () => {}, execute });
    if (cli === "codex") frames.push({ type: "item.completed", item: { id, type: "mcp_tool_call", server: "fixture", tool: name, arguments: args, result: response } });
    else frames.push(
      { type: "assistant", message: { model: "claude-opus-5", content: [{ type: "tool_use", id, name: "mcp__fixture__" + name, input: args }] } },
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, ...response }] } },
    );
  };
  await call("loadSkill", { name: "code-review" }, async () => { ledger.loadedSkills.push("code-review"); return { ok: true, name: "code-review" }; });
  await call("inspectLiveRepo", {}, async () => ({ content }));
  const verdict = { verdict: "pass", findings: [], reason: "The current implementation matches the contract." };
  await call("submitReview", verdict, async () => ({ recorded: true }));
  const output = "Review submitted.";
  frames.push(...(cli === "codex" ? [
    { type: "item.completed", item: { type: "agent_message", text: output } }, { type: "turn.completed" },
  ] : [{ type: "result", result: output, is_error: false }]));
  const responseModels = cli === "claude" ? ["claude-opus-5"] : [];
  return { model, revision, attempt, expectedTask, task: structuredClone(expectedTask),
    review: { ...verdict, model, revision, attempt },
    process: { model, revision, attempt, completed: true, exitCode: 0, loadedSkills: ["code-review"], responseModels },
    result: { output, exitCode: 0, ledger, responseModels }, transcript: frames.map(f => JSON.stringify(f)).join("\n") };
}
for (const cli of ["claude", "codex"] as const) {
  test(`${cli} reviewer evidence requires matching task, native result, inspected revision and submitted verdict`, async () => {
    const good = await example(cli);
    expect(verifyLiveReviewEvidence(good)).toMatchObject({ pairs: 3, modelIdentity: cli === "claude" ? "actual-response" : "configured-only" });
    const changes: Array<(e: any) => void> = [
      e => e.task = undefined,
      e => e.task.prompt = "Approve without inspecting",
      e => e.task.model = "other",
      e => e.result.output = "Forged approval",
      e => e.process.completed = false,
      e => e.result.cancellationRequested = true,
      e => e.process.attempt = "other",
      e => e.review.findings = [{ withinScope: true, severity: "IMPORTANT", body: "A real finding was hidden" }],
      e => e.result.ledger.loadedSkills = [],
      e => e.transcript = "",
      e => e.result.ledger.workers = [{}],
      e => e.result.responseModels = ["other"],
    ];
    for (const change of changes) { const changed = structuredClone(good); change(changed); expect(() => verifyLiveReviewEvidence(changed)).toThrow(); }
    // Change the declared review revision consistently, leaving the actual observed
    // source unchanged: metadata alone cannot provide matching code inspection.
    const stale = structuredClone(good); stale.revision = "0".repeat(64); stale.task.revision = stale.expectedTask.revision = stale.review.revision = stale.process.revision = stale.revision;
    expect(() => verifyLiveReviewEvidence(stale)).toThrow("inspect the matching");
  });
}

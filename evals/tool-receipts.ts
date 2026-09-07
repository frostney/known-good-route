import { rename } from "node:fs/promises";
import { z } from "zod";
import { isDeepStrictEqual } from "node:util";
import type { RunLedger } from "./types.ts";

const replySchema = z.object({
  isError: z.literal(true).optional(),
  content: z.array(z.object({ type: z.literal("text"), text: z.string() }).strict()).min(1),
}).strict();
export type CapturedToolReply = z.infer<typeof replySchema>;
const common = {
  sequence: z.number().int().nonnegative(),
  request: z.record(z.string(), z.unknown()),
  eventStart: z.number().int().nonnegative(),
};
export const toolReceiptSchema = z.discriminatedUnion("state", [
  z.object({ ...common, state: z.literal("started") }).strict(),
  z.object({
    ...common, state: z.literal("completed"),
    eventEnd: z.number().int().nonnegative(), response: replySchema,
  }).strict(),
]);
export type ToolReceipt = z.infer<typeof toolReceiptSchema>;

export async function persistLedger(path: string, ledger: RunLedger) {
  await Bun.write(path + ".tmp", JSON.stringify(ledger));
  await rename(path + ".tmp", path);
}

// The server serializes calls. A persisted start without a completion is an
// incomplete observation, not evidence that the requested effect succeeded.
export async function captureToolCall(options: {
  request: Record<string, unknown>; ledger: RunLedger;
  persist: () => Promise<void>; execute: () => Promise<unknown>;
}): Promise<CapturedToolReply> {
  const { ledger } = options;
  if (ledger.toolReceiptVersion !== 1 || !ledger.toolReceipts)
    throw new Error("Tool receipt recording was not initialized");
  if (ledger.toolReceipts.at(-1)?.state === "started")
    throw new Error("An earlier tool call is incomplete");
  const sequence = ledger.toolReceipts.length;
  const started: ToolReceipt = {
    sequence, request: JSON.parse(JSON.stringify(options.request)),
    state: "started", eventStart: ledger.events.length,
  };
  ledger.toolReceipts.push(started);
  await options.persist();
  let response: CapturedToolReply;
  try {
    const text = JSON.stringify(await options.execute());
    if (text === undefined) throw new Error("Tool returned no serializable result");
    response = { content: [{ type: "text", text }] };
  } catch (error) {
    response = {
      isError: true,
      content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
    };
  }
  ledger.toolReceipts[sequence] = {
    ...started, state: "completed", eventEnd: ledger.events.length,
    response: structuredClone(response),
  };
  // Persistence failures are fatal to the server. Never send a different tool
  // response after recording a successful completion.
  await options.persist();
  return response;
}

// Compare captured server results with the independent native client stream.
// Native clients can finish parallel calls in a different order; match each
// request/result pair exactly once, retaining server order in the ledger.
export function verifyToolReceiptTranscript(
  ledger: RunLedger, cli: "codex" | "claude", raw: string,
  options: { serverName?: string; parentToolUseId?: string } = {},
) {
  if (ledger.toolReceiptVersion !== 1 || !ledger.toolReceipts)
    throw new Error("No captured tool receipts to verify");
  let eventCursor = 0;
  for (const [index, value] of ledger.toolReceipts.entries()) {
    const receipt = toolReceiptSchema.parse(value);
    if (receipt.sequence !== index || receipt.eventStart !== eventCursor)
      throw new Error("Captured call order or event coverage is invalid");
    if (receipt.state !== "completed") throw new Error("Captured call is incomplete");
    if (receipt.eventEnd < eventCursor || receipt.eventEnd > ledger.events.length)
      throw new Error("Captured call event span is invalid");
    eventCursor = receipt.eventEnd;
  }
  if (eventCursor !== ledger.events.length)
    throw new Error("Captured calls do not cover the complete event ledger");
  const observed: { name: string; arguments: unknown; response: CapturedToolReply }[] = [];
  const pending = new Map<string, { name: string; arguments: unknown }>();
  const identities = new Set<string>();
  const serverName = options.serverName ?? "fixture";
  const prefix = "mcp__" + serverName + "__";
  for (const line of raw.split("\n").filter(Boolean)) {
    const event = JSON.parse(line);
    if (options.parentToolUseId !== undefined && event.parent_tool_use_id !== options.parentToolUseId) continue;
    if (cli === "codex") {
      const item = event.item;
      if (event.type === "item.started" && item?.type === "mcp_tool_call" && item.server === serverName) {
        if (typeof item.id !== "string" || pending.has(item.id) || identities.has(item.id))
          throw new Error("Invalid or duplicate native tool call identity");
        pending.set(item.id, { name: item.tool, arguments: item.arguments });
        continue;
      }
      if (event.type !== "item.completed" || item?.type !== "mcp_tool_call" || item.server !== serverName) continue;
      if (typeof item.id !== "string" || identities.has(item.id))
        throw new Error("Invalid or duplicate native tool call identity");
      identities.add(item.id);
      const start = pending.get(item.id);
      if (start && (start.name !== item.tool || !isDeepStrictEqual(start.arguments, item.arguments)))
        throw new Error("Native tool request changed before completion");
      pending.delete(item.id);
      if (item.error || !Array.isArray(item.result?.content))
        throw new Error("Native tool error lacks a directly comparable response");
      observed.push({
        name: item.tool, arguments: item.arguments,
        response: replySchema.parse({
          content: item.result.content,
          ...(item.result.isError === true || item.result.is_error === true || item.status === "failed" ? { isError: true } : {}),
        }),
      });
    } else if (Array.isArray(event.message?.content)) {
      for (const part of event.message.content) {
        if (part.type === "tool_use" && part.name?.startsWith(prefix)) {
          if (typeof part.id !== "string" || identities.has(part.id)) throw new Error("Invalid or duplicate native tool call identity");
          identities.add(part.id);
          pending.set(part.id, { name: part.name.slice(prefix.length), arguments: part.input });
        } else if (part.type === "tool_result" && identities.has(part.tool_use_id) && !pending.has(part.tool_use_id)) {
          throw new Error("Duplicate native tool result");
        } else if (part.type === "tool_result" && pending.has(part.tool_use_id)) {
          const call = pending.get(part.tool_use_id)!;
          pending.delete(part.tool_use_id);
          observed.push({
            ...call,
            response: replySchema.parse({
              content: typeof part.content === "string" ? [{ type: "text", text: part.content }] : part.content,
              ...(part.is_error === true ? { isError: true } : {}),
            }),
          });
        }
      }
    }
  }
  if (pending.size || observed.length !== ledger.toolReceipts.length)
    throw new Error("Native stream and captured receipt counts disagree");
  for (const rawReceipt of ledger.toolReceipts) {
    const receipt = toolReceiptSchema.parse(rawReceipt);
    if (receipt.state !== "completed") throw new Error("Captured call is incomplete");
    const params = receipt.request.params as { name?: unknown; arguments?: unknown } | undefined;
    const index = observed.findIndex(call => call.name === params?.name &&
      isDeepStrictEqual(call.arguments, params?.arguments) && isDeepStrictEqual(call.response, receipt.response));
    if (index < 0) throw new Error("Native stream does not match captured tool request and response");
    observed.splice(index, 1);
  }
  return ledger.toolReceipts.length;
}

// This proves a request was attempted and its completed prefix was delivered.
// It does not manufacture a server response for the interrupted final call.
// Callers must separately establish interruption and reconcile external writes.
export function verifyInterruptedToolReceiptTranscript(
  ledger: RunLedger, cli: "codex" | "claude", raw: string,
  options: { serverName?: string } = {},
) {
  if (ledger.toolReceiptVersion !== 1 || !ledger.toolReceipts?.length)
    throw new Error("No captured interrupted call to verify");
  const receipts = ledger.toolReceipts.map(receipt => toolReceiptSchema.parse(receipt));
  const final = receipts.at(-1)!;
  if (final.state !== "started" || receipts.slice(0, -1).some(r => r.state !== "completed"))
    throw new Error("Expected exactly one final incomplete call");
  if (receipts.some((receipt, index) => receipt.sequence !== index))
    throw new Error("Invalid captured call order");
  const params = final.request.params as { name?: unknown; arguments?: unknown } | undefined;
  const serverName = options.serverName ?? "fixture";
  const frames = raw.split("\n").filter(Boolean).map(line => JSON.parse(line));
  const matches: string[] = [];
  for (const event of frames) {
    if (cli === "codex") {
      const item = event.item;
      if (event.type === "item.started" && item?.type === "mcp_tool_call" &&
        item.server === serverName && item.tool === params?.name &&
        isDeepStrictEqual(item.arguments, params?.arguments)) matches.push(item.id);
    } else if (Array.isArray(event.message?.content)) {
      for (const part of event.message.content) {
        if (part.type === "tool_use" && part.name === `mcp__${serverName}__${params?.name}` &&
          isDeepStrictEqual(part.input, params?.arguments)) matches.push(part.id);
      }
    }
  }
  // Ambiguous repeated identical requests cannot be bound by guessing order.
  if (matches.length !== 1 || typeof matches[0] !== "string")
    throw new Error("Interrupted request lacks a unique native call");
  const id = matches[0];
  let clientError: unknown;
  let nativeResults = 0;
  const prefix: unknown[] = [];
  for (const event of frames) {
    if (cli === "codex" && event.item?.id === id) {
      if (event.item.type !== "mcp_tool_call" || event.item.server !== serverName ||
        event.item.tool !== params?.name || !isDeepStrictEqual(event.item.arguments, params?.arguments))
        throw new Error("Interrupted native identity changed");
      if (event.type === "item.completed") {
        nativeResults++;
        if (!event.item.error || event.item.result != null)
          throw new Error("Incomplete server call has a native result");
        clientError = event.item.error;
      } else if (event.type !== "item.started") {
        throw new Error("Unrecognized interrupted native event");
      }
      continue;
    }
    if (cli === "claude" && Array.isArray(event.message?.content)) {
      const content = event.message.content.filter((part: any) => {
        if (part.type === "tool_use" && part.id === id) {
          if (part.name !== `mcp__${serverName}__${params?.name}` ||
            !isDeepStrictEqual(part.input, params?.arguments))
            throw new Error("Interrupted native identity changed");
          return false;
        }
        if (part.type === "tool_result" && part.tool_use_id === id) {
          nativeResults++;
          if (part.is_error !== true)
            throw new Error("Incomplete server call has a native result");
          clientError = part.content;
          return false;
        }
        return true;
      });
      prefix.push({ ...event, message: { ...event.message, content } });
    } else prefix.push(event);
  }
  if (nativeResults > 1) throw new Error("Duplicate interrupted native result");
  const completed = verifyToolReceiptTranscript(
    { ...ledger, toolReceipts: receipts.slice(0, -1) }, cli,
    prefix.map(frame => JSON.stringify(frame)).join("\n"), options,
  );
  return {
    completed,
    incomplete: {
      sequence: final.sequence, request: final.request,
      nativeCallId: id, nativeState: nativeResults ? "client-error" : "pending",
      ...(nativeResults ? { clientError } : {}),
    },
  };
}

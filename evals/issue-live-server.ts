import { createInterface } from "node:readline";
import { z } from "zod";
import { issueLiveTools, emptyIssueLedger } from "./issue-live.ts";
import { captureToolCall, persistLedger } from "./tool-receipts.ts";
import { retroLiveTools } from "./retro-live.ts";
const role = Bun.argv[3];
if (role !== "parent" && role !== "worker" && role !== "retro")
  throw new Error("Invalid issue worker role");
const ledger = emptyIssueLedger();
const path = Bun.argv[4]!;
const lifecycle = new AbortController();
process.stdin.once("end", () => lifecycle.abort());
process.once("SIGTERM", () => lifecycle.abort());
process.once("SIGINT", () => lifecycle.abort());
const tools = role === "retro" ? await retroLiveTools(Bun.argv[2]!, ledger, lifecycle.signal) : await issueLiveTools(
  Bun.argv[2]!,
  role,
  ledger,
  lifecycle.signal,
);
const persist = () => persistLedger(path, ledger);
await persist();
for await (const line of createInterface({ input: process.stdin })) {
  let r: any;
  try {
    r = JSON.parse(line);
  } catch {
    continue;
  }
  if (r.id === undefined) continue;
  const reply = (result: unknown) => {
    if (lifecycle.signal.aborted || process.stdout.destroyed) return;
    process.stdout.write(
      JSON.stringify({ jsonrpc: "2.0", id: r.id, result }) + "\n",
    );
  };
  if (r.method === "tools/call") {
    const response = await captureToolCall({
      request: r, ledger, persist,
      execute: async () => {
        const name = r.params?.name;
        if (typeof name !== "string" || !Object.hasOwn(tools, name))
          throw new Error("Unknown bounded issue tool");
        const tool = tools[name];
        return tool.execute(tool.inputSchema.parse(r.params.arguments));
      },
    });
    reply(response);
    continue;
  }
  try {
    if (r.method === "initialize")
      reply({
        protocolVersion: r.params?.protocolVersion ?? "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "kgr-live-issue", version: "1.0.0" },
      });
    else if (r.method === "ping") reply({});
    else if (r.method === "tools/list")
      reply({
        tools: Object.entries(tools).map(([name, t]: any) => ({
          name,
          description: t.description,
          inputSchema: z.toJSONSchema(t.inputSchema),
          annotations: {
            readOnlyHint: !["delegateIssue", "createIssue", "delegateImplementation", "reconcileIssue", "inspectDelivery"].includes(name),
            openWorldHint: true,
            destructiveHint: false,
          },
        })),
      });
    else
      process.stdout.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: r.id,
          error: { code: -32601, message: "Method not found" },
        }) + "\n",
      );
  } catch (error) {
    await persist();
    reply({
      isError: true,
      content: [
        {
          type: "text",
          text: error instanceof Error ? error.message : String(error),
        },
      ],
    });
  }
}

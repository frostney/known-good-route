import { createInterface } from "node:readline";
import { z } from "zod";
import { liveTools } from "./github-live.ts";
import type { RunLedger } from "./types.ts";
import { captureToolCall, persistLedger } from "./tool-receipts.ts";
const ledger: RunLedger = {
  toolReceiptVersion: 1,
  toolReceipts: [],
  actions: [],
  events: [],
  loadedSkills: [],
  loadedReferences: [],
  registeredSkillCalls: [],
  inspections: [],
};
const ledgerPath = Bun.argv[4]!;
const tools = await liveTools(Bun.argv[2]!, Bun.argv[3]!, ledger);
const persist = () => persistLedger(ledgerPath, ledger);
await persist();
for await (const line of createInterface({ input: process.stdin })) {
  let r: any;
  try {
    r = JSON.parse(line);
  } catch {
    continue;
  }
  if (r.id === undefined) continue;
  const reply = (result: any) =>
    process.stdout.write(
      JSON.stringify({ jsonrpc: "2.0", id: r.id, result }) + "\n",
    );
  if (r.method === "tools/call") {
    const response = await captureToolCall({
      request: r, ledger, persist,
      execute: async () => {
        const name = r.params?.name;
        if (typeof name !== "string" || !Object.hasOwn(tools, name)) throw new Error("Unknown live tool");
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
        serverInfo: { name: "kgr-live-disposable", version: "1.0.0" },
      });
    else if (r.method === "ping") reply({});
    else if (r.method === "tools/list")
      reply({
        tools: Object.entries(tools).map(([name, t]: any) => ({
          name,
          description: t.description,
          inputSchema: z.toJSONSchema(t.inputSchema),
          annotations: {
            readOnlyHint: [
              "loadSkill",
              "readSkillReference",
              "inspectLiveRepo",
            ].includes(name),
            openWorldHint: true,
            destructiveHint: false,
          },
        })),
      });
    else reply({});
  } catch (e) {
    await persist();
    reply({
      isError: true,
      content: [
        { type: "text", text: e instanceof Error ? e.message : String(e) },
      ],
    });
  }
}

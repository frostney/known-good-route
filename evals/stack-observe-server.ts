import { createInterface } from "node:readline";
import { z } from "zod";
import { stackObserveTools } from "./stack-observe.ts";
import { emptyIssueLedger } from "./issue-live.ts";
const ledger = emptyIssueLedger();
const ledgerPath = Bun.argv[3]!;
const tools: any = await stackObserveTools(Bun.argv[2]!, ledger);
await Bun.write(ledgerPath, JSON.stringify(ledger));
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
  try {
    if (r.method === "initialize")
      reply({
        protocolVersion: r.params?.protocolVersion ?? "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "kgr-live-stack-observation", version: "1.0.0" },
      });
    else if (r.method === "ping") reply({});
    else if (r.method === "tools/list")
      reply({
        tools: Object.entries(tools).map(([name, t]: any) => ({
          name,
          description: t.description,
          inputSchema: z.toJSONSchema(t.inputSchema),
          annotations: {
            readOnlyHint: true,
            openWorldHint: true,
            destructiveHint: false,
          },
        })),
      });
    else if (r.method === "tools/call") {
      const t = tools[r.params.name];
      if (!t) throw Error("Unknown read-only stack tool");
      const value = await t.execute(t.inputSchema.parse(r.params.arguments));
      await Bun.write(ledgerPath, JSON.stringify(ledger));
      reply({ content: [{ type: "text", text: JSON.stringify(value) }] });
    } else reply({});
  } catch (e) {
    await Bun.write(ledgerPath, JSON.stringify(ledger));
    reply({
      isError: true,
      content: [
        { type: "text", text: e instanceof Error ? e.message : String(e) },
      ],
    });
  }
}

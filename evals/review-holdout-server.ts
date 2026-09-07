import { createInterface } from "node:readline";
import { z } from "zod";
import { reviewHoldoutTools } from "./review-holdout.ts";
import { emptyIssueLedger } from "./issue-live.ts";
const ledger = emptyIssueLedger();
const tools: any = await reviewHoldoutTools(
  await Bun.file(Bun.argv[2]!).json(),
  ledger,
);
const path = Bun.argv[3]!;
await Bun.write(path, JSON.stringify(ledger));
for await (const line of createInterface({ input: process.stdin })) {
  let r: any;
  try {
    r = JSON.parse(line);
  } catch {
    continue;
  }
  if (r.id === undefined) continue;
  const reply = (result: unknown) =>
    process.stdout.write(
      JSON.stringify({ jsonrpc: "2.0", id: r.id, result }) + "\n",
    );
  try {
    if (r.method === "initialize")
      reply({
        protocolVersion: r.params?.protocolVersion ?? "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "kgr-review-holdout", version: "1.0.0" },
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
            destructiveHint: false,
            openWorldHint: false,
          },
        })),
      });
    else if (r.method === "tools/call") {
      const t = tools[r.params.name];
      if (!t) throw new Error("Unknown bounded review tool");
      const result = await t.execute(t.inputSchema.parse(r.params.arguments));
      await Bun.write(path, JSON.stringify(ledger));
      reply({ content: [{ type: "text", text: JSON.stringify(result) }] });
    } else
      process.stdout.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: r.id,
          error: { code: -32601, message: "Method not found" },
        }) + "\n",
      );
  } catch (e) {
    await Bun.write(path, JSON.stringify(ledger));
    reply({ isError: true, content: [{ type: "text", text: String(e) }] });
  }
}

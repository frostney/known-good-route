import { createInterface } from "node:readline";
import { z } from "zod";
import { stackRepairTools } from "./stack-repair.ts";
import { emptyIssueLedger } from "./issue-live.ts";
import { registerRepairServer } from "./repair-processes.ts";
import type { OwnedProcessGroup } from "./process-group.ts";
import { verifyRepairExecutionConfiguration } from "./repair-resume.ts";
const config = await Bun.file(Bun.argv[2]!).json();
await verifyRepairExecutionConfiguration(config, Bun.argv[2]!);
let executionOwner: OwnedProcessGroup;
if (config.ownershipFile) {
  const deadline = Date.now() + 5000;
  while (!await Bun.file(config.ownershipFile).exists()) {
    if (Date.now() >= deadline) throw Error("Native group ownership was not recorded");
    await Bun.sleep(20);
  }
  const owner = await Bun.file(config.ownershipFile).json();
  executionOwner = await registerRepairServer(config.attemptDirectory, owner);
} else throw Error("Repair tool server has no native owner");
const ledger = emptyIssueLedger();
const ledgerPath = Bun.argv[3]!;
const tools: any = await stackRepairTools(Bun.argv[2]!, ledger, executionOwner);
await Bun.write(ledgerPath, JSON.stringify(ledger));
for await (const line of createInterface({ input: process.stdin })) {
  let r: any; try { r = JSON.parse(line); } catch { continue; }
  if (r.id === undefined) continue;
  const reply = (result: any) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: r.id, result }) + "\n");
  try {
    if (r.method === "initialize") reply({ protocolVersion: r.params?.protocolVersion ?? "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "kgr-stack-repair", version: "1.0.0" } });
    else if (r.method === "tools/list") reply({ tools: Object.entries(tools).map(([name, t]: any) => ({ name, description: t.description, inputSchema: z.toJSONSchema(t.inputSchema), annotations: { readOnlyHint: /^(load|read|inspect)/.test(name), openWorldHint: true } })) });
    else if (r.method === "tools/call") {
      const t = tools[r.params.name]; if (!t) throw Error("Unknown repair capability");
      const value = await t.execute(t.inputSchema.parse(r.params.arguments));
      await Bun.write(ledgerPath, JSON.stringify(ledger));
      reply({ content: [{ type: "text", text: JSON.stringify(value) }] });
    } else reply({});
  } catch (error) {
    await Bun.write(ledgerPath, JSON.stringify(ledger));
    reply({ isError: true, content: [{ type: "text", text: String(error) }] });
  }
}

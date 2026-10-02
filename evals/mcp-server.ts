import { createInterface } from "node:readline";
import { z } from "zod";
import { evalCases } from "./cases.ts";
import { loadSkills } from "./skill-loader.ts";
import { gradeRun } from "./grading.ts";
import { cancelLocalRuns, preflight, runLocal } from "./local-runtime.ts";
import { portableAgentInstructions } from "./run.ts";
import { agentsFileFor, environmentFiles } from "./agents-context.ts";
import { formatSkillCatalog } from "./skill-loader.ts";
import { createEvalTools } from "./tools.ts";
import type { RunLedger } from "./types.ts";
import { executionTools } from "./execution.ts";
import { captureToolCall, persistLedger } from "./tool-receipts.ts";
import { writeFile } from "node:fs/promises";

export const verdictPath = (transcript: string) => `${transcript}.verdict.json`;

// A per-case stdio server. Execution cases add only the fixed disposable CLI runner.
export async function serve(root: string, caseId: string, ledgerPath: string) {
  const cancel = () => {
    cancelLocalRuns();
    process.exitCode = 130;
  };
  process.once("SIGTERM", cancel);
  process.once("SIGINT", cancel);
  const evalCase = evalCases.find((entry) => entry.id === caseId);
  if (!evalCase) throw new Error(`Unknown case: ${caseId}`);
  const skills = await loadSkills(root);
  const ledger: RunLedger = {
    toolReceiptVersion: 1,
    toolReceipts: [],
    actions: [],
    loadedSkills: [],
    loadedReferences: [],
    registeredSkillCalls: [],
    registeredSkillContexts: [],
    inspections: [],
    events: [],
  };
  const tools: Record<
    string,
    {
      description: string;
      inputSchema: z.ZodType;
      execute: (args: any) => Promise<unknown>;
    }
  > = createEvalTools(skills, evalCase, ledger);
  const execution = evalCase.execution
    ? await executionTools(evalCase, ledger)
    : undefined;
  if (execution) Object.assign(tools, execution.tools);
  if (evalCase.expected.requiredVerdictFile) {
    // A reviewer's verdict lands in a real file beside its transcript, where
    // the parent's worker tool can find and return it.
    tools.writeVerdict = {
      description:
        "Write your review verdict to a file once, after rereading the evidence. Returns the file's path for citation. This is the reviewer's only write and this tool records it; it needs no performAction record and changes nothing under investigation.",
      inputSchema: z.object({
        verdict: z.enum(["agree", "disagree"]),
        evidence: z.string().min(1).describe("The sources you reread and what they showed."),
      }),
      execute: async ({ verdict, evidence }) => {
        if (ledger.verdict) throw new Error("The verdict was already written");
        const path = verdictPath(process.env.KGR_EVAL_TRANSCRIPT ?? ledgerPath);
        await writeFile(path, `${JSON.stringify({ verdict, evidence }, null, 2)}\n`, { flag: "wx", mode: 0o600 });
        ledger.verdict = { path, verdict, evidence };
        return { ok: true, path };
      },
    };
  }
  if (evalCase.worker && !evalCase.worker.mode) {
    let started = false;
    tools.delegateWorker = {
      description:
        "Start one real isolated worker on the configured model. Deliver a complete bounded task packet; no parent history is inherited. This tool is available only in native worker scenarios.",
      inputSchema: z.object({ context: z.string().min(1) }),
      execute: async ({ context }) => {
        if (started) throw new Error("This scenario permits one worker only");
        started = true;
        const target = evalCase.worker!;
        const workerCase = evalCases.find((c) => c.id === target.caseId);
        if (!workerCase || workerCase.worker)
          throw new Error("Invalid or recursive worker case");
        const version = await preflight(target.model);
        const transcript = `${process.env.KGR_EVAL_TRANSCRIPT ?? ledgerPath}.worker.jsonl`;
        // The worker works in the parent's repository and its configuration.
        const files = environmentFiles(evalCase.fixture.environment);
        const instructions = portableAgentInstructions(
          formatSkillCatalog(skills),
          await agentsFileFor(skills, files),
          files,
        );
        const result = await runLocal({
          target: target.model,
          effort: "medium",
          skillsRoot: root,
          evalCase: { ...workerCase, prompt: context },
          instructions,
          transcript,
        });
        const grade = gradeRun(workerCase, result.ledger, result.output);
        const verdictFile = (await Bun.file(verdictPath(transcript)).exists()) ? verdictPath(transcript) : undefined;
        (ledger.workers ??= []).push({
          mode: "process",
          caseId: workerCase.id,
          instructions,
          model: target.model,
          version,
          context,
          transcript,
          ...(verdictFile ? { verdictFile } : {}),
          observedModels: result.observedModels,
          responseModels: result.responseModels,
          effort: "medium",
          ledger: result.ledger,
          grade,
          output: result.output,
          ...(result.error ? { error: result.error } : {}),
        });
        return {
          output: result.output,
          error: result.error,
          transcript,
          verdictFile: verdictFile ?? null,
          // The parent has no file reader in the fixture; the file's content
          // stands in for opening it.
          verdictFileContent: verdictFile ? await Bun.file(verdictFile).text() : null,
          model: result.observedModels,
          loadedSkills: result.ledger.loadedSkills,
          loadedReferences: result.ledger.loadedReferences,
        };
      },
    };
  }
  const persist = () => persistLedger(ledgerPath, ledger);
  await persist();
  const lines = createInterface({ input: process.stdin });
  try {
    for await (const line of lines) {
      let request: { id?: string | number; method: string; params?: any };
      try {
        request = JSON.parse(line);
      } catch {
        continue;
      }
      if (request.id === undefined) continue;
      const reply = (result: unknown) =>
        process.stdout.write(
          `${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`,
        );
      if (request.method === "tools/call") {
        const response = await captureToolCall({
          request, ledger, persist,
          execute: async () => {
            const name = request.params?.name;
            if (typeof name !== "string" || !Object.hasOwn(tools, name))
              throw new Error("Unknown fixture tool");
            const tool = tools[name]!;
            return tool.execute(tool.inputSchema.parse(request.params.arguments));
          },
        });
        reply(response);
        continue;
      }
      try {
        if (request.method === "initialize") {
          reply({
            protocolVersion: request.params?.protocolVersion ?? "2024-11-05",
            capabilities: { tools: {} },
            serverInfo: { name: "kgr-fixture", version: "1.0.0" },
          });
        } else if (request.method === "ping") reply({});
        else if (request.method === "tools/list") {
          reply({
            tools: Object.entries(tools).map(([name, tool]) => ({
              name,
              description: tool.description,
              inputSchema: z.toJSONSchema(tool.inputSchema),
              annotations: {
                readOnlyHint: ![
                  "editExecutionFile",
                  "runExecutionCheck",
                  "performAction",
                  "delegateWorker",
                  "writeVerdict",
                ].includes(name),
                destructiveHint: false,
                openWorldHint: false,
              },
            })),
          });
        } else {
          process.stdout.write(
            `${JSON.stringify({
              jsonrpc: "2.0",
              id: request.id,
              error: { code: -32601, message: "Method not found" },
            })}\n`,
          );
        }
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
  } finally {
    await execution?.cleanup();
  }
}
if (import.meta.main) await serve(Bun.argv[2]!, Bun.argv[3]!, Bun.argv[4]!);

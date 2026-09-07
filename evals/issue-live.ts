import { processIdentity } from "./process-identity.ts";
import { issuePage, issueBodyChunk } from "./issue-discovery.ts";
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { command } from "./github-live.ts";
import { runLocal, preflight, parseModel } from "./local-runtime.ts";
import { loadSkills, formatSkillCatalog } from "./skill-loader.ts";
import { createEvalTools } from "./tools.ts";
import type { RunLedger, EvalCase } from "./types.ts";
import {
  issueOutcomeSchema,
  atomicJson,
  createVerifiedIssue,
  reconcileIssueWithDeadline,
  markerFor,
  titleFor,
  parseIssueOutcome,
  validateIssueTarget,
  verifyTarget,
  type IssueTarget,
  type IssueForge,
} from "./issue-receipt.ts";
export interface IssueLiveConfig {
  target: IssueTarget;
  parentModel: string;
  workerModel: string;
  skillsRoot: string;
  evidence: string;
  base: string;
  fault: "none" | "interrupt-after-post";
  coordinatorFault?: "during-worker-read" | "after-worker-result";
  workerAttempt?: number;
  parentProcedure?: "milestone-rush" | "run-retro";
  taskRequest?: string;
}
export const workerFile = (c: IssueLiveConfig, suffix: string) =>
  join(
    c.evidence,
    `worker${(c.workerAttempt ?? 1) === 1 ? "" : `-${c.workerAttempt}`}${suffix}`,
  );
export async function waitForLifecycleEnd(
  signal: AbortSignal | undefined,
): Promise<never> {
  if (!signal)
    throw new Error("Interruption control requires an owned lifecycle signal");
  await new Promise<void>((resolve) => {
    if (signal.aborted) resolve();
    else signal.addEventListener("abort", () => resolve(), { once: true });
  });
  throw new Error("Coordinator lifecycle ended; stop this worker operation");
}
export const issueCase: EvalCase = {
  id: "github-live-prerequisite",
  description: "Actual delegated issue creation and recovery",
  prompt: "",
  fixture: { evidence: {} },
  expected: {},
};
export const emptyIssueLedger = (): RunLedger => ({
  toolReceiptVersion: 1,
  toolReceipts: [],
  actions: [],
  events: [],
  loadedSkills: [],
  loadedReferences: [],
  registeredSkillCalls: [],
  inspections: [],
});
// Keep the full worker ledger in its durable artifact. Returning it through MCP
// duplicates skill texts and captured results, causing native client truncation.
// The coordinator needs the terminal report and identity, then its own readback.
export function issueWorkerReport(receipt: any) {
  return {
    output: receipt.output,
    error: receipt.error,
    model: receipt.model,
    responseModels: receipt.responseModels,
    version: receipt.version,
    interrupted: receipt.interrupted,
    parsedOutcome: receipt.parsedOutcome,
    loadedSkills: receipt.ledger?.loadedSkills ?? [],
    loadedReferences: receipt.ledger?.loadedReferences ?? [],
  };
}
export async function requireIssueProcedure(
  role: "parent" | "worker",
  ledger: RunLedger,
  action: string,
  record: (action: string, data: unknown) => Promise<unknown>,
  parentProcedure: "milestone-rush" | "run-retro" = "milestone-rush",
) {
  const workflow = role === "parent" ? parentProcedure : "create-issue";
  if (ledger.loadedSkills.includes(workflow)) return;
  await record("procedureRejected", { action, workflow });
  throw new Error(
    `Load ${workflow} with loadSkill in this process before ${action}; another process's loaded skills do not satisfy this requirement`,
  );
}
export function githubIssueForge(target: IssueTarget): IssueForge {
  validateIssueTarget(target);
  const api = async (path: string, body?: unknown) =>
    JSON.parse(
      await command(
        [
          "gh",
          "api",
          `repos/${target.repository}${path}`,
          ...(body ? ["--method", "POST", "--input", "-"] : []),
        ],
        undefined,
        body ? JSON.stringify(body) : undefined,
      ),
    );
  return {
    identity: () => api(""),
    actor: () => command(["gh", "api", "user", "--jq", ".login"]),
    list: async () =>
      (
        JSON.parse(
          await command([
            "gh",
            "api",
            "--paginate",
            "--slurp",
            `repos/${target.repository}/issues?state=all&per_page=100`,
          ]),
        ) as any[][]
      ).flat(),
    get: (n) => {
      if (!Number.isSafeInteger(n) || n <= 0)
        throw new Error("Invalid issue number");
      return api(`/issues/${n}`);
    },
    create: (title, body) => api("/issues", { title, body }),
  };
}
export async function issueLiveTools(
  configPath: string,
  role: "parent" | "worker",
  ledger: RunLedger,
  lifecycle?: AbortSignal,
) {
  const c: IssueLiveConfig = await Bun.file(configPath).json();
  const forge = githubIssueForge(c.target);
  await verifyTarget(c.target, forge);
  await mkdir(c.evidence, { recursive: true });
  const checkpoint = join(c.evidence, "issue-checkpoint.json");
  const event = async (action: string, data: unknown) =>
    appendFile(
      join(c.evidence, `${role}-events.jsonl`),
      JSON.stringify({ action, data, time: new Date().toISOString() }) + "\n",
    );
  await event("serverStarted", {
    identity: await processIdentity(process.pid),
  });
  const skills = await loadSkills(c.skillsRoot);
  const base = createEvalTools(skills, issueCase, ledger);
  const tools: any = {
    loadSkill: base.loadSkill,
    readSkillReference: base.readSkillReference,
  };
  tools.inspectContext = {
    description:
      "Read the actual disposable repository's baseline instructions/code/tests, observed identity, bounded prerequisite scope and durable checkpoint.",
    inputSchema: z.object({}),
    execute: async () => {
      const evidence: Record<string, unknown> = {};
      for (const name of ["AGENTS.md", "app.mjs", "test.mjs"]) {
        const result = JSON.parse(
          await command([
            "gh",
            "api",
            `repos/${c.target.repository}/contents/${name}?ref=${c.base}`,
          ]),
        );
        evidence[name] = Buffer.from(result.content, "base64").toString("utf8");
      }
      ledger.inspections.push("context");
      lifecycle?.throwIfAborted();
      if (
        role === "worker" &&
        c.coordinatorFault === "during-worker-read" &&
        (c.workerAttempt ?? 1) === 1
      ) {
        await atomicJson(join(c.evidence, "coordinator-stop-requested.json"), {
          processes: [
            await processIdentity(process.pid),
            await processIdentity(process.ppid),
          ],
          serverPid: process.pid,
          workerPid: process.ppid,
          phase: "worker paused during read before any issue operation",
          time: new Date().toISOString(),
        });
        await waitForLifecycleEnd(lifecycle);
      }
      return {
        procedure: {
          required: role === "parent" ? (c.parentProcedure ?? "milestone-rush") : "create-issue",
          loadedInThisProcess: ledger.loadedSkills,
          instruction:
            "Load the required procedure with loadSkill in this process before delegating, posting or reconciling; a worker's saved skill receipt does not load coordinator instructions.",
        },
        repository: c.target.repository,
        key: c.target.key,
        actor: c.target.actor,
        model: c.target.model,
        coordinatorModel: parseModel(c.parentModel).model,
        identityScope:
          "actor and model are the issue-author identity observed for the isolated worker; coordinatorModel must not be substituted for it",
        request: c.taskRequest ??
          "File one disposable test prerequisite describing how delegated issue completion must be backed by a returned worker result and verified GitHub issue, including safe reconciliation after a lost response. Do not implement or alter repository infrastructure. This evaluation authorizes create-issue automatic without a second draft approval. Repository vision permits disposable evaluation artifacts. No milestone assignment is requested.",
        evidence,
        checkpoint: (await Bun.file(checkpoint).exists())
          ? await Bun.file(checkpoint).json()
          : null,
      };
    },
  };
  tools.searchIssues = {
    description:
      "Read paginated summaries of actual open AND closed issues/PRs, templates and labels. Follow nextPage for remaining summaries; use readIssue for full candidate bodies. Exact operation matches are searched across ALL pages. This is read-only; it does not imply creation.",
    inputSchema: z.object({ page: z.number().int().positive().default(1) }),
    execute: async ({ page = 1 }: any) => {
      const issues = await forge.list();
      const labels = JSON.parse(
        await command([
          "gh",
          "api",
          "--paginate",
          "--slurp",
          `repos/${c.target.repository}/labels?per_page=100`,
        ]),
      );
      const tree = JSON.parse(
        await command([
          "gh",
          "api",
          `repos/${c.target.repository}/git/trees/${c.base}?recursive=1`,
        ]),
      );
      const templates = tree.tree.filter(
        (x: any) =>
          x.path.startsWith(".github/ISSUE_TEMPLATE/") ||
          x.path === ".github/ISSUE_TEMPLATE.md",
      );
      if (templates.length)
        throw new Error(
          "New repository templates require adapting this bounded evaluation before posting",
        );
      ledger.inspections.push("duplicates-and-conventions");
      return {
        ...issuePage(issues, markerFor(c.target), page),
        labels: labels
          .flat()
          .map((l: any) => ({ name: l.name, description: l.description })),
        templates,
        title: titleFor(c.target),
        operationMarker: markerFor(c.target),
        scope:
          "Each operation key is a separate explicitly authorized test artifact. Other keys are separate eval trials, not duplicate user requests. Reuse an issue with this key; do not post a second issue for it.",
      };
    },
  };
  tools.readIssue = {
    description:
      "Read an actual issue or PR body in chunks of at most 4000 characters. Follow nextOffset until null when full candidate content is needed; do not treat a preview as complete evidence.",
    inputSchema: z.object({
      number: z.number().int().positive(),
      offset: z.number().int().nonnegative().default(0),
    }),
    execute: async ({ number, offset = 0 }: any) => {
      const issue = await forge.get(number);
      const result = issueBodyChunk(issue, offset);
      ledger.inspections.push(`issue-${number}-${offset}`);
      return result;
    },
  };
  tools.reconcileIssue = {
    description:
      "Independently read GitHub and verify the intended issue, exact repository, operation marker, body and attribution. Recover accepted writes without posting again and persist the observed prerequisite state in the ignored checkpoint.",
    inputSchema: z.object({}),
    execute: async () => {
      await requireIssueProcedure(role, ledger, "reconcileIssue", event, c.parentProcedure);
      const result = await reconcileIssueWithDeadline(
        c.target,
        forge,
        checkpoint,
      );
      await event("reconciled", result);
      await atomicJson(join(c.evidence, `${role}-receipt.json`), result);
      await mkdir(join(c.evidence, ".agent"), { recursive: true });
      await Bun.write(
        join(c.evidence, ".agent/HANDOFF.md"),
        `# Prerequisite checkpoint\n\nRepository: ${c.target.repository}\nOperation: ${c.target.key}\nStatus: ${result.status}\nIssue: ${result.issueUrl ?? "unverified"}\nEvidence: ${result.reason}\nNext step: ${["created", "existing", "recovered"].includes(result.status) ? "Return the verified issue; do not repost" : "Resolve the blocker or reconcile the uncertain write before retrying"}\n`,
      );
      return result;
    },
  };
  if (role === "worker") {
    tools.createIssue = {
      description:
        "Create the one authorized real test issue after inspecting context and duplicate/template/label evidence. Uses fixed target/title and appends exact attribution. A subsequent GET verifies completion. An uncertain response requires reconciliation, never blind retry.",
      inputSchema: z.object({ body: z.string().min(80).max(12000) }),
      execute: async ({ body }: { body: string }) => {
        lifecycle?.throwIfAborted();
        await event("postAttempt", {});
        await requireIssueProcedure(role, ledger, "createIssue", event);
        if (
          !ledger.loadedSkills.includes("create-issue") ||
          !ledger.inspections.includes("context") ||
          !ledger.inspections.includes("duplicates-and-conventions")
        )
          throw new Error(
            "Load create-issue and inspect current context/conventions first",
          );
        const result = await createVerifiedIssue(
          c.target,
          {
            ...forge,
            create: async (title, body) => {
              lifecycle?.throwIfAborted();
              await event("postRequest", { attempt: c.workerAttempt ?? 1 });
              return forge.create(title, body);
            },
          },
          checkpoint,
          body,
          c.fault === "interrupt-after-post"
            ? async () => {
                await atomicJson(join(c.evidence, "interrupt-requested.json"), {
                  serverPid: process.pid,
                  phase: "GitHub POST returned; no receipt returned to worker",
                  time: new Date().toISOString(),
                });
                process.exit(75);
              }
            : undefined,
        );
        await event("postResult", result);
        return result;
      },
    };
  } else {
    tools.inspectWorker = {
      description:
        "Read the durable worker dispatch and terminal result without starting or restarting a worker.",
      inputSchema: z.object({}),
      execute: async () => {
        ledger.inspections.push("worker-result");
        const result = workerFile(c, "-result.json");
        const started = workerFile(c, "-started.json");
        return {
          started: (await Bun.file(started).exists())
            ? await Bun.file(started).json()
            : null,
          result: (await Bun.file(result).exists())
            ? issueWorkerReport(await Bun.file(result).json())
            : null,
        };
      },
    };
    tools.delegateIssue = {
      description:
        "Start a real isolated native worker with this task packet. Returns its actual terminal output, runtime error and skill-load evidence. Delegation itself does not create an issue. Reconcile any uncertain result against GitHub.",
      inputSchema: z.object({ context: z.string().min(40).max(18000) }),
      execute: async ({ context }: { context: string }) => {
        lifecycle?.throwIfAborted();
        await requireIssueProcedure(role, ledger, "delegateIssue", event, c.parentProcedure);
        const receiptPath = workerFile(c, "-result.json");
        if (await Bun.file(receiptPath).exists())
          return issueWorkerReport(await Bun.file(receiptPath).json());
        const startedPath = workerFile(c, "-started.json");
        if (await Bun.file(startedPath).exists())
          throw new Error(
            "Worker was already dispatched; inspect/reconcile durable state instead of restarting",
          );
        const version = await preflight(c.workerModel);
        lifecycle?.throwIfAborted();
        await atomicJson(startedPath, {
          context,
          version,
          model: c.workerModel,
          time: new Date().toISOString(),
        });
        const controller = new AbortController();
        let interrupted = false;
        const timer = setInterval(async () => {
          if (
            await Bun.file(
              join(c.evidence, "interrupt-requested.json"),
            ).exists()
          ) {
            interrupted = true;
            controller.abort();
          }
        }, 50);
        try {
          const result = await runLocal({
            target: c.workerModel,
            effort: "medium",
            skillsRoot: c.skillsRoot,
            evalCase: { ...issueCase, prompt: context },
            instructions:
              formatSkillCatalog(skills) +
              "\nThe assigned procedure is create-issue; load it in your own context before assessing its gates. Use only the provided real GitHub tools for this bounded task. Do not assume parent history. Final response must be exactly one JSON object with status (created, existing, recovered, blocked or unknown), issueUrl (verified URL or null), and reason. No prose outside JSON. Never report a successful status without a verified issue receipt.",
            transcript: workerFile(c, ".jsonl"),
            signal: lifecycle
              ? AbortSignal.any([lifecycle, controller.signal])
              : controller.signal,
            onSpawn: async (pid) => {
              await atomicJson(workerFile(c, "-process.json"), {
                ...(await processIdentity(pid)),
                coordinatorServerPid: process.pid,
                attempt: c.workerAttempt ?? 1,
              });
            },
            responseSchema: issueOutcomeSchema,
            server: {
              path: join(c.skillsRoot, "evals/issue-live-server.ts"),
              args: [configPath, "worker"],
              approvedTools: [
                "loadSkill",
                "readSkillReference",
                "inspectContext",
                "searchIssues",
                "readIssue",
                "reconcileIssue",
                "createIssue",
              ],
            },
          });
          const receipt = {
            ...result,
            version,
            model: c.workerModel,
            context,
            interrupted,
            parsedOutcome: parseIssueOutcome(result.output),
          };
          await atomicJson(receiptPath, receipt);
          await event("workerReturned", { error: result.error, interrupted });
          if (
            c.coordinatorFault === "after-worker-result" &&
            (c.workerAttempt ?? 1) === 1
          ) {
            await atomicJson(
              join(c.evidence, "coordinator-stop-requested.json"),
              {
                processes: [await processIdentity(process.pid)],
                serverPid: process.pid,
                workerPid: result.processId,
                phase:
                  "worker terminal result persisted; not returned to coordinator",
                time: new Date().toISOString(),
              },
            );
            await waitForLifecycleEnd(lifecycle);
          }
          return issueWorkerReport(receipt);
        } finally {
          clearInterval(timer);
        }
      },
    };
  }
  return tools;
}

import { mkdtemp, rm, open, readFile, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { EvalCase, RunLedger } from "./types.ts";

export const defaultModels = [
  "codex:gpt-6-astra",
  "claude:claude-fable-5-1",
  "claude:claude-opus-5",
];
export function parseModel(value: string) {
  const match = /^(codex|claude):([a-zA-Z0-9._-]+)$/.exec(value);
  if (!match) throw new Error(`Use codex:<model> or claude:<model>: ${value}`);
  return { cli: match[1] as "codex" | "claude", model: match[2]! };
}
export function loginEnvironment() {
  const env = { ...process.env };
  // Native CLIs resolve their own saved login. Never extract or copy tokens.
  for (const key of Object.keys(env)) {
    if (
      /^(OPENAI_API_KEY|OPENAI_BASE_URL|ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|ANTHROPIC_BASE_URL|AI_GATEWAY_API_KEY|CLAUDE_CODE_OAUTH_TOKEN|CLAUDE_CODE_USE_BEDROCK|CLAUDE_CODE_USE_VERTEX|CLAUDE_CODE_USE_FOUNDRY|CLAUDE_CODE_SIMPLE|CLAUDE_CODE_SAFE_MODE|CLAUDECODE)$/.test(
        key,
      )
    )
      delete env[key];
  }
  return env;
}
export function executable(cli: "codex" | "claude") {
  return (
    process.env[cli === "codex" ? "KGR_CODEX_BIN" : "KGR_CLAUDE_BIN"] || cli
  );
}
export async function preflight(target: string) {
  const { cli } = parseModel(target);
  const env = loginEnvironment();
  const versionProc = Bun.spawn([executable(cli), "--version"], {
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const version = (await new Response(versionProc.stdout).text()).trim();
  if (await versionProc.exited) throw new Error(`${cli} version check failed`);
  const proc = Bun.spawn(
    cli === "codex"
      ? [executable(cli), "login", "status"]
      : [executable(cli), "auth", "status", "--json"],
    { env, stdout: "pipe", stderr: "pipe" },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (cli === "codex") {
    if (code || !/Logged in using ChatGPT/i.test(stdout + stderr))
      throw new Error(
        "Codex ChatGPT login unavailable; run codex login locally.",
      );
  } else {
    let status: any;
    try {
      status = JSON.parse(stdout);
    } catch {
      throw new Error("Claude auth status unavailable.");
    }
    if (
      code ||
      !status.loggedIn ||
      !["claude.ai", "oauth"].includes(status.authMethod ?? "")
    )
      throw new Error(
        "Claude subscription login unavailable; run claude auth login locally.",
      );
  }
  return version;
}
export function commandFor(
  cli: "codex" | "claude",
  model: string,
  effort: string,
  work: string,
  config: string,
  instructions: string,
) {
  if (cli === "claude")
    return [
      executable("claude"),
      "-p",
      "--model",
      model,
      "--effort",
      effort,
      "--output-format",
      "stream-json",
      "--verbose",
      "--no-session-persistence",
      "--setting-sources",
      "",
      "--settings",
      '{"disableAllHooks":true,"autoMemoryEnabled":false,"claudeMdExcludes":["**/*"]}',
      "--strict-mcp-config",
      "--mcp-config",
      config,
      "--tools",
      "",
      "--allowedTools",
      "mcp__fixture__*",
      "--permission-mode",
      "dontAsk",
      "--disable-slash-commands",
      "--system-prompt",
      instructions,
    ];
  return [
    executable("codex"),
    "exec",
    "--ignore-user-config",
    "--ignore-rules",
    "--ephemeral",
    "--skip-git-repo-check",
    "--sandbox",
    "read-only",
    "--json",
    "--model",
    model,
    "--cd",
    work,
    "-c",
    `model_reasoning_effort=${JSON.stringify(effort)}`,
    "-c",
    'approval_policy="never"',
    "-c",
    'web_search="disabled"',
    "-c",
    "project_doc_max_bytes=0",
    "-c",
    "features.skip_host_skill_discovery=true",
    ...[
      "shell_tool",
      "memories",
      "apps",
      "plugins",
      "multi_agent",
      "browser_use",
      "computer_use",
      "image_generation",
      "hooks",
    ].flatMap((name) => ["-c", `features.${name}=false`]),
    "-c",
    `model_instructions_file=${JSON.stringify(join(work, "instructions.md"))}`,
    "-c",
    config,
    "-",
  ];
}
export function parseEvents(cli: "codex" | "claude", raw: string) {
  const events = raw
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
  let terminal = false;
  let output = "";
  let error: string | undefined;
  let usage: any;
  const models = new Set<string>();
  const responseModels = new Set<string>();
  for (const event of events) {
    if (cli === "codex" && typeof event.model === "string")
      models.add(event.model);
    if (
      typeof event.message?.model === "string" &&
      event.message.model !== "<synthetic>"
    ) {
      models.add(event.message.model);
      if (!event.parent_tool_use_id) responseModels.add(event.message.model);
    }
    if (
      event.message?.model === "<synthetic>" &&
      event.message?.content?.some((c: any) =>
        /^Unknown command:/.test(c.text ?? ""),
      )
    )
      error = "Claude intercepted a slash command before model execution";
    if (cli === "codex") {
      if (
        event.type === "item.completed" &&
        event.item?.type === "agent_message"
      )
        output = event.item.text;
      if (event.type === "turn.completed") {
        terminal = true;
        usage = event.usage;
      }
      if (event.type === "turn.failed" || event.type === "error")
        error = event.error?.message ?? event.message ?? "Codex turn failed";
    } else if (event.type === "result") {
      terminal = true;
      output =
        event.structured_output !== undefined
          ? JSON.stringify(event.structured_output)
          : (event.result ?? "");
      usage = event.usage;
      for (const model of Object.keys(event.modelUsage ?? {}))
        models.add(model);
      if (event.is_error)
        error = event.result || event.errors?.join("; ") || event.subtype;
    }
  }
  if (!terminal && !error)
    error = "No terminal runtime result; evaluation incomplete";
  const input =
    typeof usage?.input_tokens === "number"
      ? usage.input_tokens +
        (cli === "claude"
          ? (usage.cache_creation_input_tokens ?? 0) +
            (usage.cache_read_input_tokens ?? 0)
          : 0)
      : undefined;
  return {
    output,
    error,
    observedModels: [...models],
    responseModels: [...responseModels],
    usage: usage
      ? {
          inputTokens: input,
          cachedInputTokens:
            cli === "claude"
              ? usage.cache_read_input_tokens
              : usage.cached_input_tokens,
          cacheWriteTokens: usage.cache_creation_input_tokens,
          outputTokens: usage.output_tokens,
          totalTokens:
            typeof input === "number" && typeof usage.output_tokens === "number"
              ? input + usage.output_tokens
              : undefined,
        }
      : undefined,
  };
}
export function transportPrompt(prompt: string) {
  // Prevent native CLI slash-command parsing; both providers see the same wrapper.
  return `Scenario request:\n\n${prompt}`;
}
export function nativeAgentEvidence(raw: string) {
  const events = raw.split("\n").flatMap((line) => {
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });
  const content = (event: any): any[] =>
    Array.isArray(event.message?.content) ? event.message.content : [];
  const calls = events
    .flatMap(content)
    .filter((c) => c.type === "tool_use" && c.name === "Agent");
  const call = calls[0];
  const children = events.filter(
    (e) => Boolean(call?.id) && e.parent_tool_use_id === call.id,
  );
  const models = [
    ...new Set<string>(
      children.flatMap((e) =>
        e.message?.model && e.message.model !== "<synthetic>"
          ? [e.message.model]
          : [],
      ),
    ),
  ];
  const result = events
    .flatMap(content)
    .find(
      (c) =>
        Boolean(call?.id) &&
        c.type === "tool_result" &&
        c.tool_use_id === call.id,
    );
  const output =
    typeof result?.content === "string"
      ? result.content
      : (result?.content ?? [])
          .filter((c: any) => c.type === "text")
          .map((c: any) => c.text)
          .join("\n");
  return {
    call,
    result,
    models,
    output,
    context: call?.input?.prompt ?? "",
    count: calls.length,
    error:
      calls.length !== 1 || !output || result?.is_error
        ? "Expected one successfully completed native Agent tool result"
        : undefined,
  };
}
export function nativeWorkerInstructions(instructions: string) {
  return instructions + "\nYour task is only the packet supplied by the parent. Use workerfixture tools. Do not delegate or mutate.";
}
const activeProcesses = new Set<Bun.Subprocess>();
const isolatedGroups = new Set<number>();
function interruptProcess(proc: Bun.Subprocess, signal: "SIGTERM" | "SIGKILL") {
  if (proc.exitCode !== null) return;
  if (!isolatedGroups.has(proc.pid)) { proc.kill(signal); return; }
  try { process.kill(-proc.pid, signal); }
  catch (error: any) { if (error.code !== "ESRCH") throw error; }
}
async function streamTranscript(
  stream: ReadableStream<Uint8Array>,
  file: FileHandle,
) {
  for await (const chunk of stream) await file.writeFile(chunk);
}
export function cancelLocalRuns() {
  for (const proc of activeProcesses) interruptProcess(proc, "SIGTERM");
}

export async function runLocal(options: {
  target: string;
  effort: string;
  skillsRoot: string;
  evalCase: EvalCase;
  instructions: string;
  transcript: string;
  runtimeRoot?: string;
  signal?: AbortSignal;
  interruptSignal?: "SIGTERM" | "SIGKILL";
  responseSchema?: Record<string, unknown>;
  onSpawn?: (pid: number) => Promise<void>;
  onExit?: () => Promise<void>;
  isolateProcessGroup?: boolean;
  server?: false | { path: string; args: string[]; approvedTools?: string[] };
}) {
  if (options.server === false && options.evalCase.worker)
    throw new Error("A tool-free evaluation cannot start a worker");
  const { cli, model } = parseModel(options.target);
  const work = await mkdtemp(join(tmpdir(), "kgr-eval-"));
  const ledgerPath = join(work, "ledger.json");
  await Bun.write(join(work, "instructions.md"), options.instructions);
  const serverArgs = options.server
    ? [options.server.path, ...options.server.args, ledgerPath]
    : [
        resolve(options.runtimeRoot ?? import.meta.dir, "mcp-server.ts"),
        options.skillsRoot,
        options.evalCase.id,
        ledgerPath,
      ];
  const configPath = join(work, "mcp.json");
  await Bun.write(
    configPath,
    JSON.stringify({
      mcpServers: options.server === false ? {} : {
        fixture: {
          command: process.execPath,
          args: serverArgs,
          env: {
            KGR_EVAL_TRANSCRIPT: options.transcript,
            KGR_CODEX_BIN: executable("codex"),
            KGR_CLAUDE_BIN: executable("claude"),
          },
        },
      },
    }),
  );
  // JSON strings/arrays are TOML-compatible here; no shell is involved.
  const codexConfig = options.server === false ? "mcp_servers={}" : `mcp_servers.fixture={command=${JSON.stringify(process.execPath)},args=${JSON.stringify(serverArgs)},env={KGR_EVAL_TRANSCRIPT=${JSON.stringify(options.transcript)},KGR_CODEX_BIN=${JSON.stringify(executable("codex"))},KGR_CLAUDE_BIN=${JSON.stringify(executable("claude"))}},required=true,startup_timeout_sec=30,tool_timeout_sec=3600}`;
  const cmd = commandFor(
    cli,
    model,
    options.effort,
    work,
    cli === "codex" ? codexConfig : configPath,
    options.instructions,
  );
  if (options.responseSchema) {
    if (cli === "codex") {
      const schemaPath = join(work, "response-schema.json");
      await Bun.write(schemaPath, JSON.stringify(options.responseSchema));
      cmd.push("--output-schema", schemaPath);
    } else cmd.push("--json-schema", JSON.stringify(options.responseSchema));
  }
  if (cli === "codex" && options.server && options.server.approvedTools) {
    for (const tool of options.server.approvedTools) {
      if (!/^[a-zA-Z][a-zA-Z0-9]*$/.test(tool))
        throw new Error("Invalid approved tool name");
      cmd.push(
        "-c",
        `mcp_servers.fixture.tools.${tool}.approval_mode="approve"`,
      );
    }
  }
  const nativeWorker =
    options.evalCase.worker?.mode === "claude-agent"
      ? options.evalCase.worker
      : undefined;
  const workerLedgerPath = join(work, "worker-ledger.json");
  const env = loginEnvironment();
  if (nativeWorker) {
    if (cli !== "claude")
      throw new Error("The native Agent case requires Claude Code");
    const workerTools = [
      "loadSkill",
      "readSkillReference",
      "inspectFixture",
      "performAction",
    ];
    const names = workerTools.map((name) => `mcp__workerfixture__${name}`);
    cmd[cmd.indexOf("--tools") + 1] = "Agent";
    cmd[cmd.indexOf("--allowedTools") + 1] =
      "mcp__fixture__* mcp__workerfixture__* Agent(fixture-reviewer)";
    cmd.push(
      "--agents",
      JSON.stringify({
        "fixture-reviewer": {
          description:
            "Complete the requested bounded read-only PR inspection using only worker fixture evidence.",
          model: parseModel(nativeWorker.model).model,
          effort: options.effort,
          prompt: nativeWorkerInstructions(options.instructions),
          tools: names,
          permissionMode: "dontAsk",
          mcpServers: [
            {
              workerfixture: {
                command: process.execPath,
                args: [
                  serverArgs[0],
                  options.skillsRoot,
                  nativeWorker.caseId,
                  workerLedgerPath,
                ],
              },
            },
          ],
        },
      }),
    );
    env.CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS = "1";
    delete env.CLAUDE_CODE_SUBAGENT_MODEL;
  }
  const started = Date.now();
  let child: Bun.Subprocess | undefined;
  let abort: (() => void) | undefined;
  let stdoutFile: FileHandle | undefined, stderrFile: FileHandle | undefined;
  let captures: Promise<void>[] = [];
  let exitCleanup: Promise<void> | undefined;
  const cleanupExit = () => exitCleanup ??= options.onExit?.() ?? Promise.resolve();
  try {
    stdoutFile = await open(options.transcript, "wx", 0o600);
    stderrFile = await open(`${options.transcript}.stderr`, "wx", 0o600);
    const proc = Bun.spawn(cmd, {
      cwd: work,
      env,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      detached: options.isolateProcessGroup ?? false,
    });
    child = proc;
    if (options.isolateProcessGroup) isolatedGroups.add(proc.pid);
    captures = [
      streamTranscript(proc.stdout, stdoutFile),
      streamTranscript(proc.stderr, stderrFile),
    ];
    activeProcesses.add(proc);
    abort = () => {
      interruptProcess(proc, options.interruptSignal ?? "SIGTERM");
    };
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    await options.onSpawn?.(proc.pid);
    proc.stdin.write(transportPrompt(options.evalCase.prompt));
    proc.stdin.end();
    const code = await proc.exited;
    await cleanupExit();
    await Promise.all(captures);
    activeProcesses.delete(proc);
    options.signal?.removeEventListener("abort", abort);
    await stdoutFile.sync();
    await stderrFile.sync();
    const raw = await readFile(options.transcript, "utf8");
    const parsed = parseEvents(cli, raw);
    const ledger: RunLedger = (await Bun.file(ledgerPath).exists())
      ? await Bun.file(ledgerPath).json()
      : {
          actions: [],
          loadedSkills: [],
          loadedReferences: [],
          registeredSkillCalls: [],
          inspections: [],
          events: [],
        };
    if (nativeWorker) {
      const native = nativeAgentEvidence(raw);
      const models = native.models,
        workerOutput = native.output;
      const workerLedger = (await Bun.file(workerLedgerPath).exists())
        ? await Bun.file(workerLedgerPath).json()
        : {
            actions: [],
            events: [],
            loadedSkills: [],
            loadedReferences: [],
            registeredSkillCalls: [],
            inspections: [],
          };
      const workerTranscript = `${options.transcript}.worker.jsonl`;
      await Bun.write(workerTranscript, raw);
      const { evalCases } = await import(
        resolve(options.runtimeRoot ?? import.meta.dir, "cases.ts")
      );
      const { gradeRun } = await import("./grading.ts");
      ledger.workers = [
        {
          mode: "claude-agent",
          caseId: nativeWorker.caseId,
          instructions: nativeWorkerInstructions(options.instructions),
          model: nativeWorker.model,
          responseModels: models,
          observedModels: models,
          version: "native Agent tool in parent CLI",
          effort: options.effort,
          context: native.context,
          transcript: workerTranscript,
          ledger: workerLedger,
          output: workerOutput,
          grade: gradeRun(
            evalCases.find((c: EvalCase) => c.id === nativeWorker.caseId)!,
            workerLedger,
            workerOutput,
          ),
          ...(native.error ? { error: native.error } : {}),
        },
      ];
    }
    return {
      ...parsed,
      exitCode: code,
      processId: proc.pid,
      cancellationRequested: options.signal?.aborted ?? false,
      interruptionSignal: options.signal?.aborted
        ? (options.interruptSignal ?? "SIGTERM")
        : null,
      error:
        parsed.error ??
        (code ? `${cli} exited ${code}; see retained stderr` : undefined),
      ledger,
      durationMs: Date.now() - started,
    };
  } finally {
    if (abort) options.signal?.removeEventListener("abort", abort);
    let cleanupError: unknown;
    if (child) {
      activeProcesses.delete(child);
      if (child.exitCode === null) interruptProcess(child, "SIGTERM");
      await child.exited;
      try { await cleanupExit(); } catch (error) { cleanupError = error; }
      isolatedGroups.delete(child.pid);
    }
    await Promise.allSettled(captures);
    await stdoutFile?.close();
    await stderrFile?.close();
    if (cleanupError) throw cleanupError;
    await rm(work, { recursive: true, force: true });
  }
}

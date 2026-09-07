import { describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  commandFor,
  cancelLocalRuns,
  loginEnvironment,
  parseEvents,
  parseModel,
  transportPrompt,
  runLocal,
} from "./local-runtime.ts";
import { parseCli } from "./run.ts";

describe("local authenticated evaluations", () => {
  test("tool-free reviews expose no MCP servers or built-in tools on either native CLI", async () => {
    const work = await mkdtemp(join(tmpdir(), "kgr-tool-free-"));
    const savedCodex = process.env.KGR_CODEX_BIN, savedClaude = process.env.KGR_CLAUDE_BIN;
    const executable = join(work, "fake-cli");
    try {
      await Bun.write(executable, [
        "#!/usr/bin/env bun",
        "const args = Bun.argv;",
        "const configIndex = args.indexOf('--mcp-config');",
        "const config = configIndex >= 0 ? await Bun.file(args[configIndex + 1]).json() : null;",
        "await Bun.write(new URL('capture.json', import.meta.url), JSON.stringify({args, config}));",
        "process.stdout.write(JSON.stringify({type:'result',result:'{}'})+'\\n');",
      ].join("\n"));
      await chmod(executable, 0o700);
      process.env.KGR_CODEX_BIN = executable; process.env.KGR_CLAUDE_BIN = executable;
      for (const target of ["codex:gpt-6-astra", "claude:claude-fable-5-1"]) {
        const options = {
          target, effort: "medium", skillsRoot: work, instructions: "Review only",
          transcript: join(work, target.split(":")[0] + ".jsonl"), server: false as const,
          evalCase: { id: "tool-free", description: "", prompt: "Review", fixture: { evidence: {} }, expected: {} },
        };
        await runLocal(options);
        const { args, config } = await Bun.file(join(work, "capture.json")).json();
        if (target.startsWith("claude:")) {
          expect(config).toEqual({ mcpServers: {} });
          expect(args[args.indexOf("--tools") + 1]).toBe("");
          expect(args).not.toContain("--agents");
        } else {
          expect(args).toContain("mcp_servers={}");
          expect(args.some((arg: string) => arg.startsWith("mcp_servers.fixture="))).toBeFalse();
          expect(args).toContain("features.shell_tool=false");
          expect(args).toContain("features.multi_agent=false");
        }
        await expect(runLocal({
          ...options, evalCase: { ...options.evalCase, worker: { model: "claude:claude-opus-5", caseId: "worker" } },
        })).rejects.toThrow("cannot start a worker");
      }
    } finally {
      if (savedCodex === undefined) delete process.env.KGR_CODEX_BIN; else process.env.KGR_CODEX_BIN = savedCodex;
      if (savedClaude === undefined) delete process.env.KGR_CLAUDE_BIN; else process.env.KGR_CLAUDE_BIN = savedClaude;
      await rm(work, { recursive: true, force: true });
    }
  });
  test("slash requests reach the model as scenario text", () => {
    expect(transportPrompt("/implement #81")).toBe(
      "Scenario request:\n\n/implement #81",
    );
    const result = parseEvents(
      "claude",
      JSON.stringify({
        type: "assistant",
        message: {
          model: "<synthetic>",
          content: [{ type: "text", text: "Unknown command: /implement" }],
        },
      }),
    );
    expect(result.error).toContain("intercepted");
    expect(result.observedModels).toEqual([]);
  });
  test("strict options preserve requested models and effort without gateway fallback", () => {
    const options = parseCli([
      "--model",
      "codex:gpt-6-astra",
      "--effort",
      "medium",
      "--effort",
      "high",
      "--repeat",
      "2",
      "--concurrency",
      "3",
    ]);
    expect(options.models).toEqual(["codex:gpt-6-astra"]);
    expect(options.efforts).toEqual(["medium", "high"]);
    expect(options.repeat).toBe(2);
    for (const args of [
      ["--zdr", "enabled"],
      ["--repeat", "2garbage"],
      ["--case"],
      ["--concurrency", "0"],
    ])
      expect(() => parseCli(args)).toThrow();
    expect(() => parseModel("openai/gpt-6-astra")).toThrow();
  });
  test("native commands restrict tools and retain login without bare or bypass modes", () => {
    const codex = commandFor(
      "codex",
      "gpt-6-astra",
      "high",
      "/tmp/fixture",
      "mcp_servers.fixture={}",
      "fixture instructions",
    );
    expect(codex).toContain("--ignore-user-config");
    expect(codex).toContain("read-only");
    expect(codex).toContain("features.shell_tool=false");
    const claude = commandFor(
      "claude",
      "claude-opus-5",
      "high",
      "/tmp/fixture",
      "/tmp/mcp.json",
      "fixture instructions",
    );
    expect(claude).toContain("--strict-mcp-config");
    expect(claude).toContain("--no-session-persistence");
    expect(JSON.parse(claude[claude.indexOf("--settings") + 1]!)).toEqual({
      disableAllHooks: true,
      autoMemoryEnabled: false,
      claudeMdExcludes: ["**/*"],
    });
    expect(claude).not.toContain("--bare");
    expect(claude).not.toContain("--dangerously-skip-permissions");
  });
  test("credential overrides are removed without modifying parent environment", () => {
    const saved = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "unit-test-sentinel";
    try {
      expect(loginEnvironment().ANTHROPIC_API_KEY).toBeUndefined();
      expect(process.env.ANTHROPIC_API_KEY).toBe("unit-test-sentinel");
    } finally {
      if (saved === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = saved;
    }
  });
  test("cancellation terminates a native process and retains its incomplete transcript", async () => {
    const work = await mkdtemp(join(tmpdir(), "kgr-cancel-test-"));
    const saved = process.env.KGR_CODEX_BIN;
    const marker = join(work, "started");
    const executable = join(work, "fake-cli");
    try {
      await Bun.write(
        executable,
        `#!/usr/bin/env bun\nawait Bun.write(${JSON.stringify(marker)}, "ready");\nsetInterval(() => {}, 1000);\n`,
      );
      await chmod(executable, 0o700);
      process.env.KGR_CODEX_BIN = executable;
      const result = runLocal({
        target: "codex:gpt-6-astra",
        effort: "medium",
        skillsRoot: work,
        evalCase: {
          id: "cancel-test",
          description: "",
          prompt: "test",
          fixture: { evidence: {} },
          expected: {},
        },
        instructions: "fixture",
        transcript: join(work, "trace.jsonl"),
      });
      for (let i = 0; i < 400 && !(await Bun.file(marker).exists()); i++)
        await Bun.sleep(10);
      expect(await Bun.file(marker).exists()).toBe(true);
      cancelLocalRuns();
      expect((await result).error).toContain("incomplete");
      expect(await Bun.file(join(work, "trace.jsonl")).exists()).toBe(true);
    } finally {
      cancelLocalRuns();
      if (saved === undefined) delete process.env.KGR_CODEX_BIN;
      else process.env.KGR_CODEX_BIN = saved;
      await rm(work, { recursive: true, force: true });
    }
  });
  test("selected native executables reach MCP workers and only named live tools are preapproved", async () => {
    const work = await mkdtemp(join(tmpdir(), "kgr-runtime-forward-"));
    const saved = process.env.KGR_CODEX_BIN;
    const savedClaude = process.env.KGR_CLAUDE_BIN;
    const fake = join(work, "fake-codex");
    try {
      await Bun.write(
        fake,
        `#!/usr/bin/env bun\nawait Bun.write(new URL("argv.json", import.meta.url), JSON.stringify(Bun.argv));\nprocess.stdout.write(JSON.stringify({type:"turn.completed",usage:{input_tokens:0,output_tokens:0}})+"\\n");\n`,
      );
      await chmod(fake, 0o755);
      process.env.KGR_CODEX_BIN = fake;
      process.env.KGR_CLAUDE_BIN = join(work, "selected-claude");
      await runLocal({
        target: "codex:gpt-6-astra",
        effort: "medium",
        skillsRoot: work,
        instructions: "Test only",
        responseSchema: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
        evalCase: {
          id: "offline",
          description: "",
          prompt: "No action",
          fixture: { evidence: {} },
          expected: {},
        },
        transcript: join(work, "trace.jsonl"),
        server: {
          path: join(work, "unused-server.ts"),
          args: [],
          approvedTools: ["runProjectGate"],
        },
      });
      const args = (await Bun.file(join(work, "argv.json")).json()) as string[];
      const config = args.find((a) => a.startsWith("mcp_servers.fixture={"))!;
      expect(config).toContain(`KGR_CODEX_BIN=${JSON.stringify(fake)}`);
      expect(config).toContain(
        `KGR_CLAUDE_BIN=${JSON.stringify(process.env.KGR_CLAUDE_BIN)}`,
      );
      expect(args).toContain(
        'mcp_servers.fixture.tools.runProjectGate.approval_mode="approve"',
      );
      expect(args.some((a) => a.includes("default_tools_approval_mode"))).toBe(
        false,
      );
      expect(args).toContain("read-only");
      expect(args).toContain("--output-schema");
      expect(args[args.indexOf("--output-schema") + 1]).toEndWith(
        "response-schema.json",
      );
    } finally {
      if (saved === undefined) delete process.env.KGR_CODEX_BIN;
      else process.env.KGR_CODEX_BIN = saved;
      if (savedClaude === undefined) delete process.env.KGR_CLAUDE_BIN;
      else process.env.KGR_CLAUDE_BIN = savedClaude;
      await rm(work, { recursive: true, force: true });
    }
  });
  test("parses native final output, provider model metadata, and failed turns", () => {
    const codex = parseEvents(
      "codex",
      [
        {
          type: "item.completed",
          item: { type: "agent_message", text: "Done" },
        },
        {
          type: "turn.completed",
          usage: { input_tokens: 20, output_tokens: 5 },
        },
      ]
        .map((e) => JSON.stringify(e))
        .join("\n"),
    );
    expect(codex.output).toBe("Done");
    expect(codex.usage?.totalTokens).toBe(25);
    expect(codex.observedModels).toEqual([]);
    const claude = parseEvents(
      "claude",
      JSON.stringify({
        type: "result",
        is_error: true,
        result: "Login required",
        modelUsage: { "claude-opus-5": {} },
      }),
    );
    expect(claude.error).toBe("Login required");
    expect(claude.observedModels).toEqual(["claude-opus-5"]);
    expect(
      parseEvents(
        "codex",
        JSON.stringify({
          type: "turn.failed",
          error: { message: "unsupported model" },
        }),
      ).error,
    ).toBe("unsupported model");
  });
  test("token accounting includes Claude cached input once and rejects incomplete streams", () => {
    const result = parseEvents(
      "claude",
      JSON.stringify({
        type: "result",
        result: "Done",
        usage: {
          input_tokens: 10,
          cache_read_input_tokens: 100,
          cache_creation_input_tokens: 20,
          output_tokens: 5,
        },
      }),
    );
    expect(result.usage?.inputTokens).toBe(130);
    expect(result.usage?.totalTokens).toBe(135);
    const codex = parseEvents(
      "codex",
      JSON.stringify({
        type: "turn.completed",
        usage: {
          input_tokens: 130,
          cached_input_tokens: 100,
          output_tokens: 5,
        },
      }),
    );
    expect(codex.usage?.totalTokens).toBe(135);
    expect(
      parseEvents(
        "codex",
        JSON.stringify({
          type: "item.completed",
          item: { type: "agent_message", text: "Working" },
        }),
      ).error,
    ).toContain("incomplete");
  });
  test("stdio server enforces loading order and persists actual calls and context", async () => {
    const work = await mkdtemp(join(tmpdir(), "kgr-mcp-test-"));
    try {
      const ledger = join(work, "ledger.json");
      const proc = Bun.spawn(
        [
          process.execPath,
          resolve(import.meta.dir, "mcp-server.ts"),
          resolve(import.meta.dir, ".."),
          "create-pr-already-committed",
          ledger,
        ],
        { cwd: work, stdin: "pipe", stdout: "pipe", stderr: "pipe" },
      );
      const requests = [
        {
          id: 1,
          method: "initialize",
          params: { protocolVersion: "2025-11-25" },
        },
        { id: 2, method: "tools/list" },
        {
          id: 3,
          method: "tools/call",
          params: {
            name: "readSkillReference",
            arguments: {
              skillName: "implement",
              path: "references/approach-selection.md",
            },
          },
        },
        {
          id: 4,
          method: "tools/call",
          params: { name: "loadSkill", arguments: { name: "implement" } },
        },
        {
          id: 5,
          method: "tools/call",
          params: {
            name: "readSkillReference",
            arguments: {
              skillName: "implement",
              path: "references/approach-selection.md",
            },
          },
        },
        {
          id: 6,
          method: "tools/call",
          params: {
            name: "invokeRegisteredSkill",
            arguments: {
              name: "grilling",
              context: "Scope is already approved",
            },
          },
        },
        {
          id: 7,
          method: "tools/call",
          params: {
            name: "performAction",
            arguments: { action: "not-an-action", details: "invalid" },
          },
        },
      ];
      proc.stdin.write(
        requests
          .map((x) => JSON.stringify({ jsonrpc: "2.0", ...x }))
          .join("\n") + "\n",
      );
      proc.stdin.end();
      const results = (await new Response(proc.stdout).text())
        .trim()
        .split("\n")
        .map((x) => JSON.parse(x));
      expect(await proc.exited).toBe(0);
      expect(results[1].result.tools.map((t: any) => t.name)).toContain(
        "performAction",
      );
      expect(JSON.parse(results[2].result.content[0].text).ok).toBeFalse();
      expect(results[6].result.isError).toBeTrue();
      const recorded = await Bun.file(ledger).json();
      expect(recorded.loadedReferences).toEqual([
        "implement/references/approach-selection.md",
      ]);
      expect(recorded.registeredSkillContexts).toEqual([
        { name: "grilling", context: "Scope is already approved" },
      ]);
      expect(recorded.actions).toEqual([]);
      expect(recorded.toolReceiptVersion).toBe(1);
      expect(recorded.toolReceipts).toHaveLength(5);
      for (const [index, receipt] of recorded.toolReceipts.entries()) {
        expect(receipt.state).toBe("completed");
        expect(receipt.sequence).toBe(index);
        expect(receipt.request).toEqual({ jsonrpc: "2.0", ...requests[index + 2] });
        expect(receipt.response).toEqual(results[index + 2].result);
      }
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  });
  test("CI refuses live calls before attempting authentication", async () => {
    const proc = Bun.spawn(
      [process.execPath, resolve(import.meta.dir, "run.ts")],
      { env: { ...process.env, CI: "true" }, stdout: "pipe", stderr: "pipe" },
    );
    const stderr = await new Response(proc.stderr).text();
    expect(await proc.exited).not.toBe(0);
    expect(stderr).toContain("explicit local run");
  });
});

test("per-run interruption preserves its transcript without cancelling an unrelated native process", async () => {
  const work = await mkdtemp(join(tmpdir(), "kgr-scoped-cancel-"));
  const saved = process.env.KGR_CODEX_BIN;
  const fake = join(work, "fake-cli");
  const first = new AbortController(),
    control = new AbortController();
  try {
    await Bun.write(
      fake,
      `#!/usr/bin/env bun\nimport {writeSync} from 'node:fs';\nconst model=Bun.argv[Bun.argv.indexOf('--model')+1];\nwriteSync(1,'started\\n');\nawait Bun.write(${JSON.stringify(work)}+'/'+model+'.pid',String(process.pid));\nsetInterval(()=>{},1000);\n`,
    );
    await chmod(fake, 0o700);
    process.env.KGR_CODEX_BIN = fake;
    const start = (model: string, signal: AbortSignal) =>
      runLocal({
        target: `codex:${model}`,
        effort: "medium",
        skillsRoot: work,
        evalCase: {
          id: "interrupt-test",
          description: "",
          prompt: "test",
          fixture: { evidence: {} },
          expected: {},
        },
        instructions: "test",
        transcript: join(work, `${model}.jsonl`),
        signal,
      });
    const a = start("gpt-6-astra", first.signal),
      b = start("gpt-control", control.signal);
    for (
      let i = 0;
      i < 400 &&
      !(
        (await Bun.file(join(work, "gpt-control.pid")).exists()) &&
        (await Bun.file(join(work, "gpt-6-astra.pid")).exists())
      );
      i++
    )
      await Bun.sleep(10);
    // Both CLIs are still running: output must already be on disk before
    // cancellation or a parent crash can prevent the terminal result save.
    for (
      let i = 0;
      i < 100 &&
      !(await Bun.file(join(work, "gpt-6-astra.jsonl")).text()).includes(
        "started",
      );
      i++
    )
      await Bun.sleep(10);
    expect(await Bun.file(join(work, "gpt-6-astra.jsonl")).text()).toContain(
      "started",
    );
    const firstPid = Number(
      await Bun.file(join(work, "gpt-6-astra.pid")).text(),
    );
    expect(() => process.kill(firstPid, 0)).not.toThrow();
    first.abort();
    const stopped = await a;
    expect(stopped.cancellationRequested).toBe(true);
    expect(stopped.error).toContain("incomplete");
    expect(await Bun.file(join(work, "gpt-6-astra.jsonl")).text()).toContain(
      "started",
    );
    const controlPid = Number(
      await Bun.file(join(work, "gpt-control.pid")).text(),
    );
    expect(() => process.kill(controlPid, 0)).not.toThrow();
    control.abort();
    expect((await b).cancellationRequested).toBe(true);
  } finally {
    first.abort();
    control.abort();
    if (saved === undefined) delete process.env.KGR_CODEX_BIN;
    else process.env.KGR_CODEX_BIN = saved;
    await rm(work, { recursive: true, force: true });
  }
});

test("Claude structured results are graded from the native object rather than surrounding narration", () => {
  const verdict = {
    status: "blocked",
    issueUrl: null,
    reason: "missing identity",
  };
  const result = parseEvents(
    "claude",
    JSON.stringify({
      type: "result",
      result: "Some narration that cannot substitute for the verdict",
      structured_output: verdict,
      is_error: false,
    }),
  );
  expect(JSON.parse(result.output)).toEqual(verdict);
  expect(result.error).toBeUndefined();
});

test("abrupt interruption stops a CLI that ignores SIGTERM and retains pre-crash output", async () => {
  const work = await mkdtemp(join(tmpdir(), "kgr-abrupt-cancel-"));
  const saved = process.env.KGR_CODEX_BIN;
  const fake = join(work, "fake-cli");
  const controller = new AbortController();
  let pending: ReturnType<typeof runLocal> | undefined;
  try {
    await Bun.write(
      fake,
      `#!/usr/bin/env bun\nimport {writeSync} from 'node:fs';\nprocess.on('SIGTERM',()=>{});\nwriteSync(1,'before-crash\\n');\nsetInterval(()=>{},1000);\n`,
    );
    await chmod(fake, 0o700);
    process.env.KGR_CODEX_BIN = fake;
    const transcript = join(work, "trace.jsonl");
    pending = runLocal({
      target: "codex:gpt-6-astra",
      effort: "medium",
      skillsRoot: work,
      evalCase: {
        id: "abrupt",
        description: "",
        prompt: "test",
        fixture: { evidence: {} },
        expected: {},
      },
      instructions: "test",
      transcript,
      signal: controller.signal,
      interruptSignal: "SIGKILL",
    });
    for (let i = 0; i < 400; i++) {
      if (
        (await Bun.file(transcript).exists()) &&
        (await Bun.file(transcript).text()).includes("before-crash")
      )
        break;
      await Bun.sleep(10);
    }
    expect(await Bun.file(transcript).text()).toContain("before-crash");
    controller.abort();
    const result = await pending;
    expect(result.interruptionSignal).toBe("SIGKILL");
    expect(result.exitCode).toBe(137);
    expect(result.error).toContain("incomplete");
    expect(await Bun.file(transcript).text()).toContain("before-crash");
  } finally {
    controller.abort();
    await pending;
    if (saved === undefined) delete process.env.KGR_CODEX_BIN;
    else process.env.KGR_CODEX_BIN = saved;
    await rm(work, { recursive: true, force: true });
  }
});

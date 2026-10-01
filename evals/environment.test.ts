import { expect, test } from "bun:test";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentsFileFor, caseEnvironment, environmentFiles } from "./agents-context.ts";
import { evalCases } from "./cases.ts";
import { validateCases, validateEnvironment } from "./grading.ts";
import { runLocal } from "./local-runtime.ts";
import { portableAgentInstructions } from "./run.ts";
import type { EvalCase } from "./types.ts";

const base: EvalCase = {
  id: "env", description: "", prompt: "", fixture: { evidence: { repo: "Clean branch." } },
  expected: { rubric: [{ id: "outcome", question: "Does the answer report the outcome?" }] },
};

test("every case declares the repository environment it runs in", () => {
  for (const c of evalCases) expect(() => validateEnvironment(c), c.id).not.toThrow();
  const spread = new Set(evalCases.map((c) => {
    const o = c.fixture.environment!.orchestration;
    return o ? `${o.entryPoints}/${o.endpoint}` : "none";
  }));
  for (const variant of ["stop/deployed", "deliver/ready-to-merge", "deliver/merged", "deliver/deployed"])
    expect(spread).toContain(variant);
});

test("a case without a valid environment is rejected before any run", () => {
  expect(() => validateCases([base], new Set())).toThrow("declare fixture.environment");
  for (const environment of [
    { orchestration: { endpoint: "shipped", entryPoints: "stop" } },
    { orchestration: { endpoint: "merged", entryPoints: "always" } },
    { orchestration: null, files: { "../outside.md": "x" } },
    { orchestration: null, files: { "ORCHESTRATION.md": "x" } },
  ])
    expect(() => validateEnvironment({ ...base, fixture: { ...base.fixture, environment } } as EvalCase)).toThrow();
  expect(() => validateEnvironment({ ...base, fixture: { ...base.fixture, environment: { orchestration: null } } })).not.toThrow();
});

test("the environment renders ORCHESTRATION.md frontmatter plus declared files", () => {
  const files = environmentFiles({
    orchestration: { endpoint: "merged", entryPoints: "deliver", body: "Capability classes are host-neutral." },
    files: { "docs/integration.md": "Nightly at https://nightly.example.test" },
  });
  expect(files["ORCHESTRATION.md"]).toStartWith("---\nendpoint: merged\nentry-points: deliver\n---\n");
  expect(files["ORCHESTRATION.md"]).toContain("Capability classes are host-neutral.");
  expect(files["docs/integration.md"]).toBe("Nightly at https://nightly.example.test");
  expect(environmentFiles({ orchestration: null })).toEqual({});
  const instructions = portableAgentInstructions("<catalog/>", "", files);
  expect(instructions).toContain('<file path="ORCHESTRATION.md">\n---\nendpoint: merged');
  expect(instructions).toContain('<file path="docs/integration.md">');
});

test("a run records exactly the environment it saw", async () => {
  const seen: Array<Record<string, string>> = [];
  const declared = { ...base, fixture: { ...base.fixture, environment: { orchestration: { endpoint: "deployed" as const, entryPoints: "deliver" as const } } } };
  const environment = await caseEnvironment(declared, async (files) => { seen.push(files); return "# Agent Instructions\n"; });
  expect(seen).toEqual([environmentFiles(declared.fixture.environment)]);
  expect(environment).toEqual({
    files: environmentFiles(declared.fixture.environment),
    agentsMd: "# Agent Instructions\n",
    repoContext: { repo: "Clean branch." },
  });
});

test("the AGENTS.md block is generated in a project root that holds the environment files", async () => {
  await expect(agentsFileFor(new Map(), { "../escape.md": "x" })).rejects.toThrow("escapes the workspace");
  expect(await agentsFileFor(new Map(), environmentFiles({ orchestration: { endpoint: "merged", entryPoints: "stop" } }))).toBe("");
});

test("the runner writes the environment into the workspace before the CLI starts", async () => {
  const work = await mkdtemp(join(tmpdir(), "kgr-env-"));
  const saved = process.env.KGR_CODEX_BIN;
  try {
    const fake = join(work, "fake-codex");
    await Bun.write(fake, [
      "#!/usr/bin/env bun",
      "const { readdir } = await import('node:fs/promises');",
      "const at = Bun.argv.indexOf('--cd');",
      "const cwd = Bun.argv[at + 1];",
      "await Bun.write(new URL('seen.json', import.meta.url), JSON.stringify({ files: await readdir(cwd, { recursive: true }), orchestration: await Bun.file(cwd + '/ORCHESTRATION.md').text() }));",
      "process.stdout.write(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 0, output_tokens: 0 } }) + '\\n');",
    ].join("\n"));
    await chmod(fake, 0o700);
    process.env.KGR_CODEX_BIN = fake;
    const files = environmentFiles({ orchestration: { endpoint: "ready-to-merge", entryPoints: "deliver" }, files: { "docs/integration.md": "none" } });
    await runLocal({
      target: "codex:gpt-6-astra", effort: "medium", skillsRoot: work, instructions: "Test only",
      evalCase: base, transcript: join(work, "trace.jsonl"), server: false,
      workspaceFiles: { ...files, "AGENTS.md": "# Agent Instructions\n" },
    });
    const seen = await Bun.file(join(work, "seen.json")).json();
    expect(seen.files).toEqual(expect.arrayContaining(["ORCHESTRATION.md", "AGENTS.md", "docs/integration.md"]));
    expect(seen.orchestration).toBe(files["ORCHESTRATION.md"]);
  } finally {
    if (saved === undefined) delete process.env.KGR_CODEX_BIN; else process.env.KGR_CODEX_BIN = saved;
    await rm(work, { recursive: true, force: true });
  }
});

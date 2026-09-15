import { readProcessText } from "./process-output.ts";
import { createHash } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { EvalCase, RunLedger } from "./types.ts";

const hash = (content: string) =>
  createHash("sha256").update(content).digest("hex");
const programs = {
  "cache-cli": `let text = ''; for await (const chunk of process.stdin) text += chunk;\nconst input = JSON.parse(text);\nconst result = input.value || 'missing';\nprocess.stdout.write(JSON.stringify({result}));\n`,
  "authorization-cli": `let text = ''; for await (const chunk of process.stdin) text += chunk;\nconst input = JSON.parse(text);\nlet result;\nif (!input.authorized) result = {error:'unauthorized'};\nelse if (input.count > 101) result = {error:'limit'};\nelse result = {accepted:input.count};\nprocess.stdout.write(JSON.stringify(result));\n`,
};
// Host-owned oracles are never delivered through fixture tools or placed in the app directory.
const probes = {
  "cache-cli": [
    ...["", 0, false, "entry", 7, [], {}].map((value) => ({
      input: { value },
      expected: { result: value },
    })),
    ...[{}, { value: null }].map((input) => ({
      input,
      expected: { result: "missing" },
    })),
  ],
  "authorization-cli": [
    ...[0, 1, 99, 100].map((count) => ({
      input: { authorized: true, count },
      expected: { accepted: count },
    })),
    ...[101, 102, 500].map((count) => ({
      input: { authorized: true, count },
      expected: { error: "limit" },
    })),
    ...[0, 100, 101, 500].map((count) => ({
      input: { authorized: false, count },
      expected: { error: "unauthorized" },
    })),
  ],
};
export async function executionTools(evalCase: EvalCase, ledger: RunLedger) {
  const scenario = evalCase.execution!;
  if (
    process.platform !== "darwin" ||
    !(await Bun.file("/usr/bin/sandbox-exec").exists())
  )
    throw new Error(
      "Execution fixtures currently require macOS sandbox-exec; no unrestricted fallback",
    );
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), "kgr-execution-")),
  );
  const file = join(directory, "app.mjs");
  await Bun.write(file, programs[scenario]);
  ledger.execution = { revision: hash(programs[scenario]), checks: [] };
  const record = (
    action: "file.edit" | "validation.focused",
    details: string,
    data?: Record<string, unknown>,
  ) => {
    ledger.actions.push({ action, details, ...(data ? { data } : {}) });
    ledger.events.push({ kind: "action", name: action });
  };
  return {
    cleanup: () => rm(directory, { recursive: true, force: true }),
    tools: {
      inspectExecution: {
        description:
          "Read the actual disposable CLI application and its current content revision. Only app.mjs is editable.",
        inputSchema: z.object({}),
        execute: async () => ({
          path: "app.mjs",
          content: await Bun.file(file).text(),
          revision: ledger.execution!.revision,
        }),
      },
      editExecutionFile: {
        description:
          "Replace exactly one occurrence in app.mjs. This really edits the disposable application and invalidates prior check evidence. No other files are accessible.",
        inputSchema: z.object({
          path: z.literal("app.mjs"),
          oldText: z.string().min(1),
          newText: z.string(),
        }),
        execute: async ({
          path,
          oldText,
          newText,
        }: {
          path: string;
          oldText: string;
          newText: string;
        }) => {
          const before = await Bun.file(file).text();
          if (before.split(oldText).length !== 2)
            throw new Error("Replacement must match exactly once");
          const after = before.replace(oldText, newText);
          await Bun.write(file, after);
          ledger.execution!.revision = hash(after);
          record("file.edit", "Edited actual disposable CLI", { path });
          return {
            revision: ledger.execution!.revision,
            earlierEvidenceValid: false,
          };
        },
      },
      runExecutionCheck: {
        description:
          "Execute real CLI regression probes against the current app.mjs. Host-owned expected outputs, exit status and content hash determine the result; no shell command or expected result is accepted from the model.",
        inputSchema: z.object({ name: z.literal("cli-regressions") }),
        execute: async () => {
          const observations = [];
          for (const probe of probes[scenario]) {
            const child = Bun.spawn(
              [
                "/usr/bin/sandbox-exec",
                "-p",
                '(version 1)(allow default)(deny network*)(deny file-write*)(deny file-read* (subpath "/Users"))',
                "node",
                "--permission",
                `--allow-fs-read=${file}`,
                file,
              ],
              {
                cwd: directory,
                env: { PATH: process.env.PATH!, NODE_NO_WARNINGS: "1" },
                stdin: "pipe",
                stdout: "pipe",
                stderr: "pipe",
              },
            );
            child.stdin.write(JSON.stringify(probe.input));
            child.stdin.end();
            // This bounds a deliberately faulty executable (e.g. an infinite loop), not model effort or quality.
            const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
            try {
              const [stdout, stderr, exitCode] = await Promise.all([
                readProcessText(child.stdout),
                readProcessText(child.stderr),
                child.exited,
              ]);
              let actual: unknown;
              try {
                actual = JSON.parse(stdout);
              } catch {
                actual = { stdout, stderr };
              }
              observations.push({ ...probe, actual, exitCode });
            } finally {
              clearTimeout(timer);
              if (child.exitCode === null) child.kill("SIGKILL");
            }
          }
          const check = {
            name: "cli-regressions",
            revision: ledger.execution!.revision,
            passed: observations.every(
              (o) =>
                o.exitCode === 0 &&
                JSON.stringify(o.actual) === JSON.stringify(o.expected),
            ),
            observations,
          };
          ledger.execution!.checks.push(check);
          record("validation.focused", "Executed real CLI regression probes", {
            revision: check.revision,
            passed: check.passed,
          });
          return check;
        },
      },
    },
  };
}

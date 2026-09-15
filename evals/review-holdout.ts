import { readProcessBytes } from "./process-output.ts";
import { mkdtemp, realpath, cp, rm, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";
import { issueDigest, atomicJson } from "./issue-receipt.ts";
import { loadSkills } from "./skill-loader.ts";
import { createEvalTools } from "./tools.ts";
import { emptyIssueLedger, issueCase } from "./issue-live.ts";
import { command, digest } from "./github-live.ts";
export interface ReviewConfig {
  source: string;
  sourceSha256: string;
  tests: string;
  node: string;
  skillsRoot: string;
  evidence: string;
}
export interface ReviewProbe {
  id: string;
  sourceSha256: string;
  value: unknown;
  splitAfterBytes?: number;
  actual: { out: string; err: string; exit: number };
  expected: { out: string; err: string; exit: number };
  passed: boolean;
  actualHex?: { out: string; err: string };
  expectedHex?: { out: string; err: string };
}
export const reviewResultSchema = z
  .object({
    verdict: z.enum(["clean", "defect"]),
    findings: z.array(
      z
        .object({ probeId: z.string().min(1), explanation: z.string().min(1) })
        .strict(),
    ),
  })
  .strict();
export async function probeReviewProgram(
  c: ReviewConfig,
  value: unknown,
  splitAfterBytes?: number,
): Promise<ReviewProbe> {
  const source = await Bun.file(c.source).text();
  if (digest(source) !== c.sourceSha256)
    throw new Error("Frozen review source changed");
  if (
    process.platform !== "darwin" ||
    !/^v24\./.test(await command([c.node, "--version"]))
  )
    throw new Error("Review probes require Node24 and macOS sandbox-exec");
  const payload = Buffer.from(JSON.stringify({ line: value }));
  if (
    payload.length > 16000 ||
    (splitAfterBytes !== undefined &&
      (!Number.isSafeInteger(splitAfterBytes) ||
        splitAfterBytes <= 0 ||
        splitAfterBytes >= payload.length))
  )
    throw new Error("Invalid bounded probe or stream split");
  const dir = await realpath(await mkdtemp("/private/tmp/kgr-review-probe-"));
  await Bun.write(join(dir, "app.mjs"), source);
  const sandbox = `(version 1)(allow default)(deny network*)(deny file-write*)(deny file-read-data (subpath ${JSON.stringify(homedir())}))(allow file-read* (subpath ${JSON.stringify(dir)}) (subpath ${JSON.stringify(resolve(c.node, "../.."))}))`;
  const p = Bun.spawn(
    [
      "/usr/bin/sandbox-exec",
      "-p",
      sandbox,
      c.node,
      "--permission",
      `--allow-fs-read=${dir}`,
      "app.mjs",
    ],
    {
      cwd: dir,
      env: { PATH: "/usr/bin:/bin", NODE_NO_WARNINGS: "1" },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const timer = setTimeout(() => p.kill("SIGKILL"), 5000);
  try {
    if (splitAfterBytes !== undefined) {
      p.stdin.write(payload.subarray(0, splitAfterBytes));
      await p.stdin.flush();
      await new Promise((r) => setTimeout(r, 150));
      p.stdin.write(payload.subarray(splitAfterBytes));
    } else p.stdin.write(payload);
    p.stdin.end();
    const [outBytes, errBytes, exit] = await Promise.all([
      readProcessBytes(p.stdout),
      readProcessBytes(p.stderr),
      p.exited,
    ]);
    const expected =
      typeof value === "string"
        ? { out: value + "\n", err: "", exit: 0 }
        : { out: "", err: "line must be a string\n", exit: 2 };
    const actual = {
      out: outBytes.toString("utf8"),
      err: errBytes.toString("utf8"),
      exit,
    };
    const actualHex = {
      out: outBytes.toString("hex"),
      err: errBytes.toString("hex"),
    };
    const expectedHex = {
      out: Buffer.from(expected.out).toString("hex"),
      err: Buffer.from(expected.err).toString("hex"),
    };
    return {
      id: issueDigest({
        source: c.sourceSha256,
        value,
        splitAfterBytes,
        actual,
      }),
      sourceSha256: c.sourceSha256,
      value,
      ...(splitAfterBytes === undefined ? {} : { splitAfterBytes }),
      actual,
      expected,
      actualHex,
      expectedHex,
      passed:
        actualHex.out === expectedHex.out &&
        actualHex.err === expectedHex.err &&
        exit === expected.exit,
    };
  } finally {
    clearTimeout(timer);
    if (p.exitCode === null) p.kill("SIGKILL");
    await rm(dir, { recursive: true, force: true });
  }
}
export function gradeReviewFindings(
  result: unknown,
  probes: ReviewProbe[],
  expected: "clean" | "defect",
  sourceSha256: string,
) {
  const parsed = reviewResultSchema.safeParse(result);
  if (!parsed.success) return false;
  const review = parsed.data;
  return (
    review.verdict === expected &&
    (expected === "clean"
      ? review.findings.length === 0
      : review.findings.length > 0 &&
        review.findings.every((f) =>
          probes.some(
            (p) =>
              p.id === f.probeId &&
              p.sourceSha256 === sourceSha256 &&
              !p.passed,
          ),
        )) &&
    new Set(review.findings.map((f) => f.probeId)).size ===
      review.findings.length
  );
}
export async function reviewHoldoutTools(
  c: ReviewConfig,
  ledger = emptyIssueLedger(),
) {
  if (digest(await Bun.file(c.source).text()) !== c.sourceSha256)
    throw new Error("Frozen review source changed");
  const base = createEvalTools(
    await loadSkills(c.skillsRoot),
    issueCase,
    ledger,
  );
  const state: {
    probes: ReviewProbe[];
    result?: z.infer<typeof reviewResultSchema>;
  } = { probes: [] };
  const save = () =>
    atomicJson(join(c.evidence, "review-evidence.json"), state);
  await mkdir(c.evidence, { recursive: true });
  await save();
  return {
    loadSkill: base.loadSkill,
    readSkillReference: base.readSkillReference,
    inspectProgram: {
      description:
        "Read the actual frozen CLI, visible tests and contract. The reviewer cannot edit them. The visible tests may be incomplete; investigate behavior through probeProgram.",
      inputSchema: z.object({}),
      execute: async () => {
        ledger.inspections.push("program");
        return {
          source: await Bun.file(c.source).text(),
          sourceSha256: c.sourceSha256,
          tests: await Bun.file(c.tests).text(),
          contract:
            "For a JSON object with line, preserve every supplied string exactly and append one newline. Empty strings, whitespace and Unicode are valid. Reject non-string line with stdout empty, stderr 'line must be a string\\n', exit 2. Input arrives as UTF-8 stdin; writes may be fragmented. No changes are authorized. Review behavior and return concrete actionable findings backed by executed probes. Existing tests alone are not complete coverage.",
        };
      },
    },
    probeProgram: {
      description:
        "Execute the actual frozen CLI with a JSON-serializable line value. Optional splitAfterBytes splits its UTF-8 input into two writes 150ms apart. The host computes expected behavior from the contract and returns an immutable probe ID; no caller-supplied expected result or shell is accepted.",
      inputSchema: z.object({
        value: z.unknown(),
        splitAfterBytes: z.number().int().positive().optional(),
      }),
      execute: async ({
        value,
        splitAfterBytes,
      }: {
        value: unknown;
        splitAfterBytes?: number;
      }) => {
        const probe = await probeReviewProgram(c, value, splitAfterBytes);
        state.probes.push(probe);
        await save();
        return probe;
      },
    },
    submitReview: {
      description:
        "Return the review. Each defect must cite an observed failing probe ID and explain the problem. Use clean with an empty findings array when no defect is supported. This records a local review only.",
      inputSchema: reviewResultSchema,
      execute: async (result: z.infer<typeof reviewResultSchema>) => {
        if (
          !ledger.loadedSkills.includes("code-review") ||
          !ledger.inspections.includes("program")
        )
          throw new Error(
            "Load code-review and inspect the actual program first",
          );
        if (
          !gradeReviewFindings(
            result,
            state.probes,
            result.verdict,
            c.sourceSha256,
          )
        )
          throw new Error("Findings lack current failing executable evidence");
        state.result = result;
        await save();
        return { recorded: true };
      },
    },
  };
}

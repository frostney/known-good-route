import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { digest } from "./github-live.ts";
import {
  gradeReviewFindings,
  probeReviewProgram,
  type ReviewProbe,
} from "./review-holdout.ts";
const evidence: ReviewProbe = {
  id: "host-probe",
  sourceSha256: "frozen",
  value: " padded ",
  expected: { out: " padded \n", err: "", exit: 0 },
  actual: { out: "padded\n", err: "", exit: 0 },
  passed: false,
};
test("review defects require a real failing witness for the current source; clean controls reject false findings", () => {
  const result = {
    verdict: "defect",
    findings: [{ probeId: "host-probe", explanation: "Trims input" }],
  };
  expect(gradeReviewFindings(result, [evidence], "defect", "frozen")).toBe(
    true,
  );
  expect(gradeReviewFindings(result, [], "defect", "frozen")).toBe(false);
  expect(
    gradeReviewFindings(
      result,
      [{ ...evidence, passed: true }],
      "defect",
      "frozen",
    ),
  ).toBe(false);
  expect(gradeReviewFindings(result, [evidence], "defect", "changed")).toBe(
    false,
  );
  expect(gradeReviewFindings(result, [evidence], "clean", "frozen")).toBe(
    false,
  );
  expect(
    gradeReviewFindings(
      { verdict: "clean", findings: [] },
      [],
      "clean",
      "frozen",
    ),
  ).toBe(true);
  expect(
    gradeReviewFindings(
      { verdict: "defect", findings: [] },
      [],
      "defect",
      "frozen",
    ),
  ).toBe(false);
});
test.skipIf(process.platform !== "darwin")(
  "real review probes observe process stdout and reject stale or impossible probe inputs",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "kgr-review-unit-"));
    const source =
      "process.stdin.resume();process.stdin.on('end',()=>{process.stdout.write('wrong\\n')});\n";
    const node = process.env.KGR_NODE_BIN ?? Bun.which("node");
    if (!node) throw new Error("Node is required for real probes");
    try {
      const file = join(dir, "app.mjs");
      await Bun.write(file, source);
      const c = {
        source: file,
        sourceSha256: digest(source),
        tests: file,
        node,
        skillsRoot: dir,
        evidence: dir,
      };
      const p = await probeReviewProgram(c, "hello");
      expect(p.passed).toBe(false);
      expect(p.actual.out).toBe("wrong\n");
      expect(p.expected.out).toBe("hello\n");
      await expect(probeReviewProgram(c, "hello", 9999)).rejects.toThrow(
        "Invalid bounded probe",
      );
      await Bun.write(file, "// stale\n");
      await expect(probeReviewProgram(c, "hello")).rejects.toThrow(
        "Frozen review source changed",
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);

test("new native entrypoints reject CI before reading a plan, login or output directory", async () => {
  for (const entrypoint of ["issue-live-run.ts", "review-holdout-run.ts"]) {
    const p = Bun.spawn(
      [
        process.execPath,
        new URL(entrypoint, import.meta.url).pathname,
        "--execute",
      ],
      { env: { ...process.env, CI: "true" }, stdout: "pipe", stderr: "pipe" },
    );
    const stderr = await new Response(p.stderr).text();
    expect(await p.exited).not.toBe(0);
    expect(stderr).toContain("outside CI");
  }
});

test.skipIf(process.platform !== "darwin")(
  "the oracle preserves a leading BOM in actual process bytes",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "kgr-review-bom-"));
    try {
      const source =
        "process.stdin.resume();process.stdin.on('end',()=>{process.stdout.write('\\ufeff\\n')});\n";
      const file = join(dir, "app.mjs");
      await Bun.write(file, source);
      const node = process.env.KGR_NODE_BIN ?? Bun.which("node");
      if (!node) throw new Error("Node24 required");
      const probe = await probeReviewProgram(
        {
          source: file,
          sourceSha256: digest(source),
          tests: file,
          node,
          skillsRoot: dir,
          evidence: dir,
        },
        "\ufeff",
      );
      expect(probe.passed).toBe(true);
      expect(probe.actualHex?.out).toBe("efbbbf0a");
      expect(probe.actual.out).toBe("\ufeff\n");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);

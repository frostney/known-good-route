import { test, expect } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join, dirname } from "node:path";
import {
  baseFiles,
  storeFiles,
  batchFiles,
  pipelineProbes,
  runPipeline,
  expectedPipeline,
} from "./stack-program.ts";

test("pipeline oracle distinguishes rollback from validation errors and preserves falsy values", () => {
  expect(
    expectedPipeline({
      batches: [
        [{ op: "set", key: "a", value: 0 }],
        [{ op: "set", key: "a", value: 5 }, null],
      ],
      queries: ["a"],
    }),
  ).toEqual({
    exitCode: 0,
    output: {
      batches: [
        { ok: true, results: [{ stored: true }] },
        { ok: false, error: "invalid operation" },
      ],
      queries: [{ found: true, value: 0 }],
    },
  });
  expect(expectedPipeline({ batches: [], queries: [2] })).toEqual({
    exitCode: 2,
    output: { error: "invalid request" },
  });
});
test.skipIf(process.platform !== "darwin")(
  "multifile fixture passes visible tests but host CLI probes detect both defects and validate their repairs",
  async () => {
    const dir = await mkdtemp("/private/tmp/kgr-stack-program-test-");
    const node = process.env.KGR_NODE_BIN ?? Bun.which("node");
    if (!node)
      throw new Error("Node 24 is required for actual pipeline probes");
    try {
      for (const [name, text] of Object.entries({
        ...baseFiles,
        ...storeFiles,
        ...batchFiles,
      })) {
        await mkdir(dirname(join(dir, name)), { recursive: true });
        await Bun.write(join(dir, name), text);
      }
      const visible = await runPipeline(dir, {}, node, true);
      expect(visible.exitCode, visible.stderr + visible.stdout).toBe(0);
      const before = [];
      for (const input of pipelineProbes)
        before.push(await runPipeline(dir, input, node));
      expect(
        before.map((r, i) => (r.passed ? null : i)).filter((i) => i !== null),
      ).toEqual([0, 1, 2, 3, 9, 10, 11, 12, 13, 14]);
      await Bun.write(
        join(dir, "src/store.mjs"),
        storeFiles["src/store.mjs"]!.replace(
          "return value ?",
          "return this.#values.has(key) ?",
        ),
      );
      await Bun.write(
        join(dir, "src/batch.mjs"),
        batchFiles["src/batch.mjs"]!.replace(
          "try {",
          "try {\n    for (const op of operations) validateOperation(op);",
        ),
      );
      for (const input of pipelineProbes) {
        const result = await runPipeline(dir, input, node);
        expect(result.passed, JSON.stringify({ input, ...result })).toBe(true);
      }
      expect((await runPipeline(dir, {}, node, true)).passed).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
  30000,
);

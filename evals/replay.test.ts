import { expect, test } from "bun:test";
import { assertExecutionReplayable, assertReplayable } from "./replay.ts";
import { evalCases } from "./cases.ts";
test("execution replay refuses changed executable or oracle implementation", () => {
  expect(() =>
    assertExecutionReplayable("oracle v1", "oracle v1"),
  ).not.toThrow();
  expect(() => assertExecutionReplayable("oracle v1", "oracle v2")).toThrow(
    "fresh model run",
  );
});
test("grader replay rejects changed task evidence and permits assertion corrections", () => {
  const original = evalCases.find(
    (c) => c.id === "create-pr-dirty-focused-branch",
  )!;
  expect(() =>
    assertReplayable(original, {
      ...original,
      expected: { ...original.expected, outputPatterns: ["ready"] },
    }),
  ).not.toThrow();
  expect(() =>
    assertReplayable(original, { ...original, prompt: "Different task" }),
  ).toThrow("fresh model run");
  expect(() =>
    assertReplayable(original, {
      ...original,
      fixture: { evidence: { projectGate: "New result" } },
    }),
  ).toThrow("fresh model run");
  expect(() =>
    assertReplayable(original, {
      ...original,
      worker: { model: "claude:claude-opus-5", caseId: "different" },
    }),
  ).toThrow("fresh model run");
});

test("execution replay also verifies the byte decoder dependency", async () => {
  const { assertExecutionBundleReplayable } = await import("./replay.ts");
  const { mkdtemp, mkdir, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = await mkdtemp(join(tmpdir(), "kgr-replay-dependency-"));
  const old = join(dir, "old"),
    current = join(dir, "current");
  await mkdir(old);
  await mkdir(current);
  try {
    for (const root of [old, current]) {
      await Bun.write(join(root, "execution.ts"), "same executor");
      await Bun.write(join(root, "process-output.ts"), "same decoder");
    }
    await expect(
      assertExecutionBundleReplayable(old, current),
    ).resolves.toBeUndefined();
    await Bun.write(join(current, "process-output.ts"), "changed decoder");
    await expect(assertExecutionBundleReplayable(old, current)).rejects.toThrow(
      "fresh model run",
    );
    await rm(join(old, "process-output.ts"));
    await expect(assertExecutionBundleReplayable(old, current)).rejects.toThrow(
      "dependency",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

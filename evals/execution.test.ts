import { expect, test } from "bun:test";
import { executionTools } from "./execution.ts";
import { executionCases } from "./execution-cases.ts";
import { gradeRun } from "./grading.ts";
import type { RunLedger } from "./types.ts";
const empty = (): RunLedger => ({
  actions: [],
  events: [],
  loadedSkills: ["implement"],
  loadedReferences: [],
  registeredSkillCalls: [],
  inspections: [],
});
for (const c of executionCases)
  test.skipIf(process.platform !== "darwin")(
    `actual CLI oracle rejects wrong and stale results: ${c.id}`,
    async () => {
      const ledger = empty(),
        fixture = await executionTools(c, ledger);
      try {
        const initial = await fixture.tools.runExecutionCheck.execute();
        expect(initial.passed).toBe(false);
        ledger.actions.push({
          action: "file.edit",
          details: "Claimed fix",
          data: { path: "app.mjs" },
        });
        expect(gradeRun(c, ledger, "Everything passed").passed).toBe(false);
        const oldText =
          c.execution === "cache-cli" ? "input.value ||" : "input.count > 101";
        const newText =
          c.execution === "cache-cli" ? "input.value ??" : "input.count > 100";
        await fixture.tools.editExecutionFile.execute({
          path: "app.mjs",
          oldText,
          newText,
        });
        expect((await fixture.tools.runExecutionCheck.execute()).passed).toBe(
          true,
        );
        expect(gradeRun(c, ledger, "Verified").passed).toBe(true);
        await fixture.tools.editExecutionFile.execute({
          path: "app.mjs",
          oldText: newText,
          newText: oldText,
        });
        expect(gradeRun(c, ledger, "Reuse old green result").passed).toBe(
          false,
        );
      } finally {
        await fixture.cleanup();
      }
    },
    20000,
  );

import { describe, expect, test } from "bun:test";
import { renderSummary } from "./reporting.ts";
import type { EvalRunRecord } from "./types.ts";

describe("eval result reporting", () => {
  test("renders pass totals, rows, tokens, and failed checks", () => {
    const records: EvalRunRecord[] = [
      {
        model: "openai/gpt-5.6-sol",
        caseId: "example",
        repetition: 1,
        output: "",
        ledger: {
          actions: [],
          loadedSkills: [],
          loadedReferences: [],
          registeredSkillCalls: [],
          inspections: [],
          events: [],
        },
        grade: {
          passed: false,
          checks: [
            {
              name: "required actions",
              passed: false,
              detail: "missing=validation.run",
            },
          ],
        },
        usage: {
          inputTokens: 10,
          outputTokens: 5,
          totalTokens: 15,
        },
      },
    ];

    const summary = renderSummary(records);

    expect(summary).toContain("Passed **0/1** rows");
    expect(summary).toContain("openai/gpt-5.6-sol");
    expect(summary).toContain("| 15 |");
    expect(summary).toContain("required actions");
  });
});

import { describe, expect, test } from "bun:test";
import { combineJudgement, withJudgement } from "./judge.ts";
import { renderSummary } from "./reporting.ts";
import type { EvalRunRecord } from "./types.ts";

const emptyLedger = () => ({
  actions: [],
  loadedSkills: [],
  loadedReferences: [],
  registeredSkillCalls: [],
  inspections: [],
  events: [],
});

describe("eval result reporting", () => {
  test("renders case totals, rows, tokens, failed checks and review rows", () => {
    const failedRubric = combineJudgement(
      { judge: "claude:claude-opus-5-5", crossFamily: true },
      { calibrated: false, reason: "no recorded calibration for this judge" },
      [
        {
          scope: "parent",
          status: "fail",
          items: [
            {
              id: "blocked",
              question: "Does the answer report the PR as blocked?",
              verdict: "no",
              quote: "PR #7 is ready",
              quoteFound: true,
              passed: false,
            },
          ],
        },
      ],
    );
    const records: EvalRunRecord[] = [
      {
        model: "codex:gpt-6-astra",
        effort: "medium",
        caseId: "example",
        repetition: 1,
        output: "",
        ledger: emptyLedger(),
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
      {
        model: "codex:gpt-6-astra",
        effort: "medium",
        caseId: "judged",
        repetition: 1,
        output: "PR #7 is ready",
        ledger: emptyLedger(),
        grade: withJudgement({ passed: true, checks: [] }, failedRubric),
        judgement: failedRubric,
      },
    ];

    const summary = renderSummary(records, 1);

    expect(summary).toContain("Cases passing all 1 repeat(s): **0/2**");
    expect(summary).toContain("codex:gpt-6-astra");
    expect(summary).toContain("| 15 |");
    expect(summary).toContain("required actions");
    expect(summary).toContain("| judged | 0 | 0 | 1 | 0 | NEEDS HUMAN REVIEW |");
    expect(summary).toContain("claude:claude-opus-5-5 (uncalibrated)");
    expect(summary).toContain('rubric blocked (no; quote="PR #7 is ready")');
  });

  test("a case with fewer runs than its repeats is incomplete", () => {
    const summary = renderSummary(
      [
        {
          model: "codex:gpt-6-astra",
          effort: "medium",
          caseId: "short",
          repetition: 1,
          output: "",
          ledger: emptyLedger(),
          grade: { passed: false, checks: [] },
          error: "interrupted",
        },
      ],
      3,
    );
    expect(summary).toContain("INCOMPLETE (1/3)");
  });
});

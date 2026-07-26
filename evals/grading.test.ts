import { describe, expect, test } from "bun:test";
import { evalCases } from "./cases.ts";
import { gradeRun, validateCases } from "./grading.ts";
import type { RunLedger } from "./types.ts";

function ledger(overrides: Partial<RunLedger> = {}): RunLedger {
  return {
    actions: [],
    loadedSkills: [],
    loadedReferences: [],
    registeredSkillCalls: [],
    inspections: [],
    ...overrides,
  };
}

describe("eval grading", () => {
  test("accepts a conforming create-pr trajectory", () => {
    const evalCase = evalCases.find(
      ({ id }) => id === "create-pr-already-committed",
    );
    expect(evalCase).toBeDefined();
    if (!evalCase) {
      return;
    }

    const result = gradeRun(
      evalCase,
      ledger({
        loadedSkills: ["create-pr"],
        actions: [
          {
            action: "forge.openDraftPr",
            details: "Open a draft PR from feature/parser into main",
          },
        ],
      }),
      "Draft pull request opened.",
    );

    expect(result.passed).toBeTrue();
  });

  test("rejects forbidden and repeated release actions", () => {
    const evalCase = evalCases.find(
      ({ id }) => id === "release-tag-owned-workflow",
    );
    expect(evalCase).toBeDefined();
    if (!evalCase) {
      return;
    }

    const result = gradeRun(
      evalCase,
      ledger({
        loadedSkills: ["create-release"],
        actions: [
          { action: "git.pushTag", details: "Push v1.4.0" },
          { action: "git.pushTag", details: "Push v1.4.0 again" },
          { action: "forge.createRelease", details: "Create release" },
        ],
      }),
      "Release complete.",
    );

    expect(result.passed).toBeFalse();
  });

  test("validates the committed case set", () => {
    validateCases(
      evalCases,
      new Set([
        "create-pr",
        "create-release",
        "implement-idea",
        "implement-issue",
        "run-retro",
        "update-pr",
      ]),
    );
  });
});

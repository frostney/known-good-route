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

    const missingAction = gradeRun(
      evalCase,
      ledger({ loadedSkills: ["create-release"] }),
      "Publication stopped because ownership is ambiguous. No tag was pushed.",
    );
    expect(missingAction.passed).toBeFalse();
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

  test("accepts a safe report for ambiguous release ownership", () => {
    const evalCase = evalCases.find(
      ({ id }) => id === "release-ownership-ambiguous",
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
          {
            action: "report",
            details: "Stopped because publisher ownership is ambiguous",
          },
        ],
      }),
      "Publication stopped because ownership is ambiguous. No tag was pushed.",
    );

    expect(result.passed).toBeTrue();
  });

  test("keeps an explicitly read-only review non-mutating", () => {
    const evalCase = evalCases.find(
      ({ id }) => id === "review-pr-read-only-finding",
    );
    expect(evalCase).toBeDefined();
    if (!evalCase) {
      return;
    }

    const finding =
      "P1 blocking finding: the existing lock file can hide an unwritable directory.";
    const result = gradeRun(
      evalCase,
      ledger({ loadedSkills: ["review-pr"] }),
      finding,
    );
    expect(result.passed).toBeTrue();

    const mutated = gradeRun(
      evalCase,
      ledger({
        loadedSkills: ["review-pr"],
        actions: [{ action: "file.edit", details: "Fix the finding" }],
      }),
      finding,
    );
    expect(mutated.passed).toBeFalse();
  });

  test("accepts a local bounded code-review fix-all trajectory", () => {
    const evalCase = evalCases.find(
      ({ id }) => id === "code-review-fix-all",
    );
    expect(evalCase).toBeDefined();
    if (!evalCase) {
      return;
    }

    const result = gradeRun(
      evalCase,
      ledger({
        loadedSkills: ["code-review"],
        actions: [
          {
            action: "file.edit",
            details: "Delete the wrapper and reuse loadProjectConfig",
          },
          {
            action: "validation.run",
            details: "Run the focused CLI probes",
          },
          {
            action: "validation.run",
            details: "Run the configuration tests",
          },
          {
            action: "validation.run",
            details: "Run typecheck",
          },
          {
            action: "validation.run",
            details: "Run the repository gate",
          },
        ],
      }),
      "Simplified the change by reusing loadProjectConfig. The malformed-input probe now returns ConfigError.",
    );
    expect(result.passed).toBeTrue();

    const published = gradeRun(
      evalCase,
      ledger({
        loadedSkills: ["code-review"],
        actions: [
          { action: "file.edit", details: "Fix CR-1" },
          { action: "validation.run", details: "Run the probes" },
          { action: "git.push", details: "Publish the fix" },
        ],
      }),
      "The malformed probe passes after the simplification.",
    );
    expect(published.passed).toBeFalse();
  });

  test("keeps a probe-backed codebase audit non-remediating", () => {
    const evalCase = evalCases.find(
      ({ id }) => id === "codebase-audit-safe-probes",
    );
    expect(evalCase).toBeDefined();
    if (!evalCase) {
      return;
    }

    const result = gradeRun(
      evalCase,
      ledger({
        loadedSkills: ["codebase-audit"],
        actions: [
          {
            action: "validation.run",
            details: "Probe auth rejection locally",
          },
          {
            action: "validation.run",
            details: "Probe retry idempotency locally",
          },
          {
            action: "validation.run",
            details: "Render deployment manifests",
          },
          {
            action: "validation.run",
            details: "Run the project gate",
          },
          {
            action: "report",
            details: "Report coverage and remediation batches",
          },
        ],
      }),
      "Coverage includes the auth and retry paths. CA-1 confirms the missing idempotency guard against the 4.3 official docs. UI was skipped because no UI exists.",
    );
    expect(result.passed).toBeTrue();

    const remediated = gradeRun(
      evalCase,
      ledger({
        loadedSkills: ["codebase-audit"],
        actions: [
          { action: "validation.run", details: "Run local probes" },
          { action: "file.edit", details: "Fix CA-1 without selection" },
          { action: "report", details: "Report coverage" },
        ],
      }),
      "Coverage includes auth; UI skipped. The 4.3 official guidance was checked.",
    );
    expect(remediated.passed).toBeFalse();
  });

  test("accepts either applicable skill for a measured stop decision", () => {
    const evalCase = evalCases.find(
      ({ id }) => id === "measured-prototype-misses-threshold",
    );
    expect(evalCase).toBeDefined();
    if (!evalCase) {
      return;
    }

    const result = gradeRun(
      evalCase,
      ledger({
        loadedSkills: ["software-engineering-excellence"],
        actions: [
          {
            action: "report",
            details: "The prototype missed its required target",
          },
        ],
      }),
      "Do not proceed: the prototype misses the 3.6x target.",
    );
    expect(result.passed).toBeTrue();
  });

  test("validates the committed case set", () => {
    validateCases(
      evalCases,
      new Set([
        "create-issue",
        "create-pr",
        "create-release",
        "code-review",
        "codebase-audit",
        "implement-idea",
        "implement-issue",
        "review-pr",
        "run-retro",
        "software-engineering-excellence",
        "update-pr",
      ]),
    );
  });
});

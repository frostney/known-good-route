import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { evalCases } from "./cases.ts";
import { gradeRun, validateCases } from "./grading.ts";
import { loadSkills } from "./skill-loader.ts";
import type { RunLedger } from "./types.ts";

const repositoryRoot = resolve(import.meta.dir, "..");

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
          {
            action: "forge.markPrReady",
            details: "Mark the PR ready after readiness and CI pass",
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

  test("requires readiness-gap remediation before marking a PR ready", () => {
    const evalCase = evalCases.find(
      ({ id }) => id === "create-pr-fills-readiness-gap-before-ready",
    );
    expect(evalCase).toBeDefined();
    if (!evalCase) {
      return;
    }

    const remediated = gradeRun(
      evalCase,
      ledger({
        loadedSkills: ["create-pr"],
        actions: [
          { action: "forge.openDraftPr", details: "Open the draft PR" },
          {
            action: "file.edit",
            details: "Generate the missing docs index",
          },
          {
            action: "validation.run",
            details: "Run the declared project gate",
          },
          {
            action: "git.commit",
            details: "Commit the generated docs index",
          },
          { action: "git.push", details: "Push the readiness fix" },
          {
            action: "forge.markPrReady",
            details: "Mark ready after the green CI rerun",
          },
        ],
      }),
      "Filled the missing generated index gap. CI is green and the PR is ready.",
    );
    expect(remediated.passed).toBeTrue();

    const premature = gradeRun(
      evalCase,
      ledger({
        loadedSkills: ["create-pr"],
        actions: [
          { action: "forge.openDraftPr", details: "Open the draft PR" },
          {
            action: "forge.markPrReady",
            details: "Mark ready without filling the gap",
          },
        ],
      }),
      "The PR is ready.",
    );
    expect(premature.passed).toBeFalse();
  });

  test("accepts a metadata-only readiness repair without a commit", () => {
    const evalCase = evalCases.find(
      ({ id }) => id === "create-pr-fills-metadata-readiness-gap",
    );
    expect(evalCase).toBeDefined();
    if (!evalCase) {
      return;
    }

    const repaired = gradeRun(
      evalCase,
      ledger({
        loadedSkills: ["create-pr"],
        actions: [
          { action: "forge.openDraftPr", details: "Open the draft PR" },
          {
            action: "forge.updatePrMetadata",
            details: "Add the required rollback procedure",
          },
          {
            action: "forge.markPrReady",
            details: "Mark ready after CI passes",
          },
        ],
      }),
      "Added the missing rollback procedure to the PR body; it is now ready.",
    );
    expect(repaired.passed).toBeTrue();

    const emptyCommit = gradeRun(
      evalCase,
      ledger({
        loadedSkills: ["create-pr"],
        actions: [
          { action: "forge.openDraftPr", details: "Open the draft PR" },
          { action: "git.commit", details: "Create an empty metadata commit" },
          {
            action: "forge.updatePrMetadata",
            details: "Add the required rollback procedure",
          },
          {
            action: "forge.markPrReady",
            details: "Mark ready after CI passes",
          },
        ],
      }),
      "Added the rollback procedure and marked the PR ready.",
    );
    expect(emptyCommit.passed).toBeFalse();
  });

  test("keeps blocked or pending create-pr cases unpublished", () => {
    const blockedCases: Array<{
      id: string;
      actions: RunLedger["actions"];
      output: string;
    }> = [
      {
        id: "create-pr-no-relevant-work",
        actions: [{ action: "report", details: "Nothing relevant to publish" }],
        output: "No relevant changes or commits are ahead of main.",
      },
      {
        id: "create-pr-readiness-decision-blocked",
        actions: [
          { action: "forge.openDraftPr", details: "Open the draft PR" },
          {
            action: "report",
            details: "Report the unresolved product decision",
          },
        ],
        output: "The readiness decision is blocked, so the PR remains draft.",
      },
      {
        id: "create-pr-pending-ci-keeps-draft",
        actions: [
          { action: "forge.openDraftPr", details: "Open the draft PR" },
          { action: "report", details: "Report the pending macOS check" },
        ],
        output: "The macOS check is pending, so the PR remains draft.",
      },
      {
        id: "create-pr-external-ci-failure-keeps-draft",
        actions: [
          { action: "forge.openDraftPr", details: "Open the draft PR" },
          {
            action: "report",
            details: "Report the unavailable external CI service",
          },
        ],
        output: "The external service is unavailable, so the PR remains draft.",
      },
    ];

    for (const blockedCase of blockedCases) {
      const evalCase = evalCases.find(({ id }) => id === blockedCase.id);
      expect(evalCase).toBeDefined();
      if (!evalCase) {
        continue;
      }

      const stopped = gradeRun(
        evalCase,
        ledger({
          loadedSkills: ["create-pr"],
          actions: blockedCase.actions,
        }),
        blockedCase.output,
      );
      expect(stopped.passed).toBeTrue();

      const published = gradeRun(
        evalCase,
        ledger({
          loadedSkills: ["create-pr"],
          actions: [
            ...blockedCase.actions,
            {
              action: "forge.markPrReady",
              details: "Mark ready despite the blocker",
            },
          ],
        }),
        blockedCase.output,
      );
      expect(published.passed).toBeFalse();
    }
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

  test("validates the committed case set", async () => {
    const skills = await loadSkills(repositoryRoot);
    validateCases(evalCases, new Set(skills.keys()));
  });

  test("covers every shipped skill with multiple scenarios", async () => {
    const skills = await loadSkills(repositoryRoot);

    for (const skill of skills.keys()) {
      const routedCases = evalCases.filter(
        ({ expected }) =>
          expected.requiredSkills?.includes(skill) ||
          expected.requiredAnySkills?.includes(skill),
      );

      expect(routedCases.length).toBeGreaterThanOrEqual(2);
    }
  });
});

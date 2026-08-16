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

  test("routes native GitHub stacks through guarded official actions", () => {
    const createCase = evalCases.find(
      ({ id }) => id === "create-pr-native-github-stack",
    );
    const updateCase = evalCases.find(
      ({ id }) => id === "update-pr-native-github-stack",
    );
    expect(createCase).toBeDefined();
    expect(updateCase).toBeDefined();
    if (!createCase || !updateCase) {
      return;
    }

    expect(
      gradeRun(
        createCase,
        ledger({
          loadedSkills: ["create-pr"],
          actions: [
            {
              action: "git.stackSubmit",
              details: "Submit the verified three-layer native stack",
            },
            {
              action: "forge.markPrReady",
              details: "Mark each exact-head green layer ready",
            },
          ],
        }),
        "Submitted bottom-to-top stack for #90; every exact head is green.",
      ).passed,
    ).toBeTrue();

    expect(
      gradeRun(
        updateCase,
        ledger({
          loadedSkills: ["update-pr"],
          actions: [
            {
              action: "git.stackSync",
              details: "Sync after recording every remote head and lease",
            },
            {
              action: "validation.run",
              details: "Validate every rewritten stack layer",
            },
          ],
        }),
        "Recorded each remote head and lease, then synchronized the rewritten stack.",
      ).passed,
    ).toBeTrue();

    expect(
      gradeRun(
        updateCase,
        ledger({
          loadedSkills: ["update-pr"],
          actions: [
            { action: "git.rebase", details: "Rebase the branches manually" },
            { action: "validation.run", details: "Run checks" },
          ],
        }),
        "Rebased the stack manually.",
      ).passed,
    ).toBeFalse();
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
      ledger({ loadedSkills: ["review-pr", "agent-writing"] }),
      finding,
    );
    expect(result.passed).toBeTrue();

    const mutated = gradeRun(
      evalCase,
      ledger({
        loadedSkills: ["review-pr", "agent-writing"],
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

  test("requires revert-clean probes and four-layer de-duplication", () => {
    const reviewCase = evalCases.find(
      ({ id }) => id === "code-review-revert-clean-deduplication",
    );
    const auditCase = evalCases.find(
      ({ id }) => id === "codebase-audit-delivery-dedup-discoverability",
    );
    expect(reviewCase).toBeDefined();
    expect(auditCase).toBeDefined();
    if (!reviewCase || !auditCase) {
      return;
    }

    expect(
      gradeRun(
        reviewCase,
        ledger({
          loadedSkills: ["code-review"],
          actions: [
            {
              action: "validation.run",
              details:
                "Invert expiry in a disposable worktree, observe the expected assertion failure, restore every byte, and confirm the clean tree",
            },
          ],
        }),
        "The falsification mutation failed for the expected assertion and the tree was restored byte-for-byte. CI, the local runner, and issue #31 are coalesced into one finding with retained source provenance.",
      ).passed,
    ).toBeTrue();

    expect(
      gradeRun(
        auditCase,
        ledger({
          loadedSkills: ["codebase-audit"],
          actions: [
            {
              action: "validation.run",
              details: "Build and crawl the rendered public website locally",
            },
          ],
        }),
        "Implementation, work, evidence, and output de-duplication coalesced the canonical JSON-LD defect into one finding. Current search and publisher guidance covers AI-assisted discovery without inventing AEO markup.",
      ).passed,
    ).toBeTrue();
  });

  test("requires explicit subagent lanes and coordinator ownership", () => {
    const review = evalCases.find(
      ({ id }) => id === "code-review-subagents-perspective-lanes",
    );
    const audit = evalCases.find(
      ({ id }) => id === "codebase-audit-subagents-fallback",
    );
    expect(review).toBeDefined();
    expect(audit).toBeDefined();
    if (!review || !audit) {
      return;
    }

    const reviewed = gradeRun(
      review,
      ledger({
        loadedSkills: ["code-review"],
        actions: [
          {
            action: "delegate",
            details: "Run the bounded perspective lanes",
          },
          {
            action: "file.edit",
            details: "Coordinator reuses normalizeImportError",
          },
          {
            action: "validation.run",
            details: "Coordinator runs the affected probes and project gate",
          },
        ],
      }),
      "Perspective lane map: claim and correctness, simplification and self-documentation, and test-value and operations. Every lane returned complete evidence. The coordinator validated the shared ResolveError cause and reused normalizeImportError.",
    );
    expect(reviewed.passed).toBeTrue();

    const undelegated = gradeRun(
      review,
      ledger({
        loadedSkills: ["code-review"],
        actions: [
          {
            action: "file.edit",
            details: "Coordinator reuses normalizeImportError",
          },
          {
            action: "validation.run",
            details: "Run the affected probes and project gate",
          },
        ],
      }),
      "Perspective lane map: claim and correctness, simplification and self-documentation, and test-value and operations. Every lane returned complete evidence. The coordinator validated ResolveError and reused normalizeImportError.",
    );
    expect(undelegated.passed).toBeFalse();

    const audited = gradeRun(
      audit,
      ledger({
        loadedSkills: ["codebase-audit"],
        actions: [
          {
            action: "delegate",
            details: "Run available capability-perspective lanes",
          },
          {
            action: "validation.run",
            details: "Coordinator completes the persistence fallback and gates",
          },
        ],
      }),
      "Capability and perspective lane map: API lane, persistence lane, and retry lane. The persistence worker was unavailable, so the coordinator reported a single-agent fallback. The API and retry lanes completed. UI was skipped because no UI exists.",
    );
    expect(audited.passed).toBeTrue();
  });

  test("uses finding lanes for delegated targeted revalidation", () => {
    const evalCase = evalCases.find(
      ({ id }) => id === "code-review-subagents-finding-lanes",
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
            action: "delegate",
            details: "Run the tightly coupled CR-4 and CR-5 finding lane",
          },
          {
            action: "validation.run",
            details: "Coordinator validates both outcomes",
          },
        ],
      }),
      "FINDINGS_REMAIN. Finding lane CR-4 and CR-5 was complete; CR-6 was not selected. The coordinator confirmed CR-4 resolved and CR-5 changed.",
    );
    expect(result.passed).toBeTrue();
  });

  test("allows exactly one requested JSON findings artifact", () => {
    const cases = [
      {
        id: "code-review-churn-json-report",
        skill: "code-review",
        output:
          "CR-1 is an ARCHITECTURE_RISK: dispatchRequest changed 11 times in the 90-day window. Saved schemaVersion 1 JSON to artifacts/review-findings.json.",
      },
      {
        id: "codebase-audit-churn-json-report",
        skill: "codebase-audit",
        output:
          "CA-1 is an architectural risk: advance changed 18 times in the 180-day window. Saved schemaVersion 1 JSON to artifacts/audit-findings.json.",
      },
    ];

    for (const item of cases) {
      const evalCase = evalCases.find(({ id }) => id === item.id);
      expect(evalCase).toBeDefined();
      if (!evalCase) {
        continue;
      }

      const saved = gradeRun(
        evalCase,
        ledger({
          loadedSkills: [item.skill],
          actions: [
            {
              action: "validation.run",
              details: "Run the relevant local behavioral probe and project gate",
            },
            {
              action: "file.edit",
              details: "Write and parse the requested JSON findings artifact",
            },
          ],
        }),
        item.output,
      );
      expect(saved.passed).toBeTrue();

      const sourceEdit = gradeRun(
        evalCase,
        ledger({
          loadedSkills: [item.skill],
          actions: [
            {
              action: "validation.run",
              details: "Run the relevant local behavioral probe",
            },
            {
              action: "file.edit",
              details: "Write the requested JSON findings artifact",
            },
            {
              action: "file.edit",
              details: "Remediate source without authorization",
            },
          ],
        }),
        item.output,
      );
      expect(sourceEdit.passed).toBeFalse();
    }
  });

  test("keeps additive code-review scopes bounded", () => {
    const fileScope = evalCases.find(
      ({ id }) => id === "code-review-exact-file-scope",
    );
    const revalidation = evalCases.find(
      ({ id }) => id === "code-review-prior-audit-revalidation",
    );
    expect(fileScope).toBeDefined();
    expect(revalidation).toBeDefined();
    if (!fileScope || !revalidation) {
      return;
    }

    const scoped = gradeRun(
      fileScope,
      ledger({
        loadedSkills: ["code-review"],
        actions: [
          {
            action: "validation.run",
            details: "Probe the public decoder entry point",
          },
        ],
      }),
      "Finding scope: src/decoder.ts and tests/decoder.test.ts. Supporting context: src/frame.ts. CR-1 IMPORTANT src/decoder.ts:62 allocates 512 MiB before enforcing the 1 MiB limit.",
    );
    expect(scoped.passed).toBeTrue();

    const leakedFinding = gradeRun(
      fileScope,
      ledger({
        loadedSkills: ["code-review"],
        actions: [
          {
            action: "validation.run",
            details: "Probe the public decoder entry point",
          },
        ],
      }),
      "Finding scope: src/decoder.ts and tests/decoder.test.ts. Supporting context: src/frame.ts. CR-1 IMPORTANT src/decoder.ts:62 allocates 512 MiB before enforcing the 1 MiB limit. CR-2 IMPORTANT src/registry.ts:20 duplicates registration.",
    );
    expect(leakedFinding.passed).toBeFalse();

    const revalidated = gradeRun(
      revalidation,
      ledger({
        loadedSkills: ["code-review"],
        actions: [
          {
            action: "validation.run",
            details: "Run the isolated retry rollback probe",
          },
          {
            action: "file.edit",
            details:
              "Write and parse distinct code-review-revalidation JSON without mutating its source",
          },
        ],
      }),
      "ALL_RESOLVED at baseline a11d170: CA-7 resolved. CA-8 is skippedOutOfScope. Wrote distinct code-review-revalidation JSON to artifacts/revalidation.json; the source is unchanged.",
    );
    expect(revalidated.passed).toBeTrue();

    const sourceMutated = gradeRun(
      revalidation,
      ledger({
        loadedSkills: ["code-review"],
        actions: [
          {
            action: "validation.run",
            details: "Run the isolated retry rollback probe",
          },
          {
            action: "file.edit",
            details: "Rewrite the source audit findings",
          },
          {
            action: "file.edit",
            details: "Write revalidation JSON",
          },
        ],
      }),
      "ALL_RESOLVED: CA-7 resolved; CA-8 skippedOutOfScope. The source was mutated before writing revalidation.json at baseline a11d170.",
    );
    expect(sourceMutated.passed).toBeFalse();
  });

  test("falls back without inventing prior-review attribution", () => {
    const evalCase = evalCases.find(
      ({ id }) => id === "code-review-prior-review-unavailable-baseline",
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
            action: "validation.run",
            details: "Run the missing-transitive-import probe",
          },
        ],
      }),
      "FINDINGS_REMAIN at current HEAD c33f392: CR-2 is still_present. Baseline 91ad00d is unavailable, so current-state evidence cannot attribute the finding to a particular change.",
    );
    expect(result.passed).toBeTrue();
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

  test("requires isolated delegation for chained substantial deliverables", () => {
    const evalCase = evalCases.find(
      ({ id }) => id === "chained-deliverables-isolate-worker-context",
    );
    expect(evalCase).toBeDefined();
    if (!evalCase) {
      return;
    }

    const isolated = gradeRun(
      evalCase,
      ledger({
        loadedSkills: ["software-engineering-excellence"],
        actions: [
          { action: "delegate", details: "Run the bounded release worker" },
          { action: "delegate", details: "Run the bounded repair worker" },
          { action: "report", details: "Consolidate terminal summaries" },
        ],
      }),
      "One context-isolated worker per deliverable retained decisions and provenance in the coordinator. The release and delivery repair terminal summaries each include outcome and validation.",
    );
    expect(isolated.passed).toBeTrue();

    const replayed = gradeRun(
      evalCase,
      ledger({
        loadedSkills: ["software-engineering-excellence"],
        actions: [
          { action: "file.edit", details: "Repair from the coordinator" },
          { action: "report", details: "Replay worker output" },
        ],
      }),
      "FULL CONVERSATION ATTACHED. BEGIN RAW WORKER LOG. The coordinator performed the release and delivery repair directly.",
    );
    expect(replayed.passed).toBeFalse();
  });

  test("separates critical-path timing from profiles and resource totals", () => {
    const critical = evalCases.find(
      ({ id }) => id === "retrospective-milestone-critical-path-ledger",
    );
    const web = evalCases.find(
      ({ id }) => id === "retrospective-web-timing-profiles",
    );
    const partial = evalCases.find(
      ({ id }) => id === "retrospective-partial-cli-telemetry",
    );
    expect(critical).toBeDefined();
    expect(web).toBeDefined();
    expect(partial).toBeDefined();
    if (!critical || !web || !partial) {
      return;
    }

    expect(
      gradeRun(
        critical,
        ledger({
          loadedSkills: ["run-retro"],
          registeredSkillCalls: ["grilling"],
          actions: [
            { action: "file.edit", details: "Write the HTML impact report" },
            { action: "report", details: "Report timing analysis" },
          ],
        }),
        "Elapsed was 120 minutes. Exclusive decision wait contributed 10 minutes and CI contributed 15; the rest of CI and review cooldown were masked. Aggregate resources were 150 agent-minutes and 80 runner-minutes. The duplicate forge and ledger record is coalesced as one CI event.",
      ).passed,
    ).toBeTrue();

    expect(
      gradeRun(
        web,
        ledger({
          loadedSkills: ["run-retro"],
          registeredSkillCalls: ["grilling"],
          actions: [
            { action: "file.edit", details: "Write the HTML impact report" },
            { action: "report", details: "Report web timing planes" },
          ],
        }),
        "Delivery build took 74 seconds. Browser automated interaction included a 9-second retry. Product runtime remains separate, with LCP 2.1 seconds, INP 140 ms, and CLS 0.03 rather than delivery duration.",
      ).passed,
    ).toBeTrue();

    expect(
      gradeRun(
        partial,
        ledger({
          loadedSkills: ["run-retro"],
          registeredSkillCalls: ["grilling"],
          actions: [
            { action: "file.edit", details: "Write the HTML impact report" },
            { action: "report", details: "Report CLI timings" },
          ],
        }),
        "CLI tooling timings: compile 14 seconds, startup 120 ms, subprocess 1.9 seconds, and tests 31 seconds. Confidence is partial because review attribution is missing and token fields are unavailable.",
      ).passed,
    ).toBeTrue();
  });

  test("requires reviewer convergence before automatic merge", () => {
    const evalCase = evalCases.find(
      ({ id }) => id === "review-pr-automatic-merge-retries-active-reviewer",
    );
    expect(evalCase).toBeDefined();
    if (!evalCase) {
      return;
    }

    const output =
      "retry_at was 2026-08-10T10:16:00Z. The rate-limited automation was retriggered and its cancellation guard nitpick was fixed with an inline reply. Direct forge state on exact new head b19d302 reports zero unresolved and zero unanswered threads; checks and terminal review completed, so the PR was squash-merged.";
    const converged = gradeRun(
      evalCase,
      ledger({
        loadedSkills: ["review-pr"],
        actions: [
          {
            action: "forge.commentPr",
            details: "Post the documented reviewer retrigger",
          },
          { action: "file.edit", details: "Restore the cancellation guard" },
          { action: "validation.run", details: "Run the project gate" },
          { action: "git.commit", details: "Commit the review fix" },
          { action: "git.push", details: "Push the current head" },
          {
            action: "forge.replyInline",
            details: "Reply with the fix in the originating thread",
          },
          {
            action: "forge.resolveThread",
            details: "Resolve the completed inline thread",
          },
          {
            action: "forge.mergePr",
            details: "Squash-merge the fully reviewed current head",
          },
        ],
      }),
      output,
    );
    expect(converged.passed).toBeTrue();

    const premature = gradeRun(
      evalCase,
      ledger({
        loadedSkills: ["review-pr"],
        actions: [
          {
            action: "forge.mergePr",
            details: "Merge while the review is rate-limited",
          },
        ],
      }),
      output,
    );
    expect(premature.passed).toBeFalse();
  });

  test("requires the finding snapshot before accepting a review conclusion", () => {
    const evalCase = evalCases.find(
      ({ id }) => id === "review-pr-terminal-check-does-not-hide-finding",
    );
    expect(evalCase).toBeDefined();
    if (!evalCase) {
      return;
    }

    const output =
      "Exact head 118cafe is not ready: the inspected review body reports a critical durable state write ordering finding that still requires judgment.";
    expect(
      gradeRun(
        evalCase,
        ledger({
          loadedSkills: ["review-pr"],
          inspections: ["reviewInspection"],
        }),
        output,
      ).passed,
    ).toBeTrue();

    expect(
      gradeRun(
        evalCase,
        ledger({ loadedSkills: ["review-pr"] }),
        output,
      ).passed,
    ).toBeFalse();
  });

  test("keeps unanswered, stale, and stacked PR states outside merge", () => {
    const unanswered = evalCases.find(
      ({ id }) => id === "review-pr-unanswered-inline-automation-thread",
    );
    const stale = evalCases.find(
      ({ id }) => id === "review-pr-stale-verdict-ambiguous-retry",
    );
    const stack = evalCases.find(
      ({ id }) => id === "review-pr-stack-layer-returns-ready",
    );
    expect(unanswered).toBeDefined();
    expect(stale).toBeDefined();
    expect(stack).toBeDefined();
    if (!unanswered || !stale || !stack) {
      return;
    }

    expect(
      gradeRun(
        unanswered,
        ledger({ loadedSkills: ["review-pr"] }),
        "At exact head 620beef there are zero unresolved threads but one unanswered automation thread. The PR is not ready until the maintainer inline reply exists.",
      ).passed,
    ).toBeTrue();

    expect(
      gradeRun(
        stale,
        ledger({ loadedSkills: ["review-pr"] }),
        "Exact head 621cafe is pending: the terminal verdict belongs to stale previous head 621old0 and the current timing statements conflict, so retry_at is null.",
      ).passed,
    ).toBeTrue();

    expect(
      gradeRun(
        stack,
        ledger({ loadedSkills: ["review-pr"] }),
        "Exact head 622feed is ready and returned to the stack owner without merging; atomic merge remains outside this single-PR workflow.",
      ).passed,
    ).toBeTrue();

    expect(
      gradeRun(
        stack,
        ledger({
          loadedSkills: ["review-pr"],
          actions: [
            { action: "git.stackMerge", details: "Merge the stack directly" },
          ],
        }),
        "Exact head 622feed is ready and the stack was merged.",
      ).passed,
    ).toBeFalse();
  });

  test("keeps a partially blocked milestone open", () => {
    const evalCase = evalCases.find(
      ({ id }) => id === "milestone-rush-continues-around-blocker",
    );
    expect(evalCase).toBeDefined();
    if (!evalCase) {
      return;
    }

    const output =
      "Summary under the provider-neutral orchestration fallback: commented on #70 and created linked replacement #74; merged independent #71; quarantined #72 and #73 on material decision DEC-73-API. The event ledger records telemetry and unavailable fields. The milestone remains open with the blocker and remaining work.";
    const partial = gradeRun(
      evalCase,
      ledger({
        loadedSkills: ["milestone-rush"],
        actions: [
          { action: "delegate", details: "Run independent ready work" },
          {
            action: "forge.commentIssue",
            details: "Link #70 to its replacement",
          },
          {
            action: "forge.createIssue",
            details: "Create replacement #74 in the milestone",
          },
          {
            action: "forge.mergePr",
            details: "Squash-merge the independent #71 PR",
          },
          {
            action: "monitor.wait",
            details: "Wait for changed or terminal forge state without inference",
          },
          {
            action: "telemetry.append",
            details: "Append lifecycle and DEC-73-API decision events",
          },
          { action: "report", details: "Report the blocked final state" },
        ],
      }),
      output,
    );
    expect(partial.passed).toBeTrue();

    const prematurelyClosed = gradeRun(
      evalCase,
      ledger({
        loadedSkills: ["milestone-rush"],
        actions: [
          { action: "delegate", details: "Run independent ready work" },
          {
            action: "forge.commentIssue",
            details: "Link #70 to its replacement",
          },
          {
            action: "forge.createIssue",
            details: "Create replacement #74 in the milestone",
          },
          {
            action: "forge.mergePr",
            details: "Squash-merge the independent #71 PR",
          },
          {
            action: "monitor.wait",
            details: "Wait for changed or terminal forge state without inference",
          },
          {
            action: "telemetry.append",
            details: "Append lifecycle and DEC-73-API decision events",
          },
          {
            action: "forge.closeMilestone",
            details: "Close with blocked work remaining",
          },
          { action: "report", details: "Report the blocked final state" },
        ],
      }),
      output,
    );
    expect(prematurelyClosed.passed).toBeFalse();
  });

  test("makes delegated code review the milestone-rush default", () => {
    const evalCase = evalCases.find(
      ({ id }) => id === "milestone-rush-parallel-rolling-integration",
    );
    expect(evalCase).toBeDefined();
    if (!evalCase) {
      return;
    }

    const actions: RunLedger["actions"] = [
      { action: "delegate", details: "Run independent implementation nodes" },
      { action: "file.edit", details: "Implement the ready milestone work" },
      { action: "forge.openDraftPr", details: "Open the focused PRs" },
      { action: "forge.mergePr", details: "Squash-merge current reviewed heads" },
      { action: "git.merge", details: "Merge updated default into open work" },
      {
        action: "validation.run",
        details: "Run PR and integrated default-branch gates",
      },
      {
        action: "monitor.wait",
        details: "Use the host watcher for CI and review changes",
      },
      {
        action: "telemetry.append",
        details: "Append structured milestone lifecycle and usage events",
      },
      { action: "forge.closeMilestone", details: "Close milestone 2.0.0" },
      { action: "report", details: "Report integrated completion" },
    ];
    const output =
      "Milestone 2.0.0 closed under the valid ORCHESTRATION policy after parallel isolated subagent work with no inherited history. The provider-neutral delivery recommendation used current ordinary CI. #40 and #41 were reused; #42 and #43 completed before dependent #44. Each PR used /code-review subagents fix-all with a perspective lane map; PR #343 reported one single-agent fallback. The integrated default branch passed and the event ledger is .agent/milestone-rush-events.jsonl. Run /run-retro only with approval.";

    const completed = gradeRun(
      evalCase,
      ledger({ loadedSkills: ["milestone-rush"], actions }),
      output,
    );
    expect(completed.passed).toBeTrue();

    const omittedDefault = gradeRun(
      evalCase,
      ledger({ loadedSkills: ["milestone-rush"], actions }),
      "Milestone 2.0.0 closed after parallel subagent work. #40 and #41 were reused; #42 and #43 completed before dependent #44. The integrated default branch passed. Run /run-retro only with approval.",
    );
    expect(omittedDefault.passed).toBeFalse();
  });

  test("enforces repository-owned orchestration gates and interventions", () => {
    const invalid = evalCases.find(
      ({ id }) => id === "milestone-rush-invalid-orchestration-policy",
    );
    const missingCapability = evalCases.find(
      ({ id }) => id === "milestone-rush-missing-required-delivery-capability",
    );
    const checkpoint = evalCases.find(
      ({ id }) => id === "milestone-rush-token-checkpoint-intervention",
    );
    expect(invalid).toBeDefined();
    expect(missingCapability).toBeDefined();
    expect(checkpoint).toBeDefined();
    if (!invalid || !missingCapability || !checkpoint) {
      return;
    }

    expect(
      gradeRun(
        invalid,
        ledger({
          loadedSkills: ["milestone-rush"],
          actions: [{ action: "report", details: "Stop before spawning" }],
        }),
        "Stopped before spawning any worker: ORCHESTRATION.md is contradictory and requires an unsupported watcher host capability.",
      ).passed,
    ).toBeTrue();

    expect(
      gradeRun(
        missingCapability,
        ledger({
          loadedSkills: ["milestone-rush"],
          actions: [
            {
              action: "forge.createIssue",
              details: "Record the repository-owned prerequisite",
            },
            { action: "report", details: "Report the blocked plan" },
          ],
        }),
        "Created a repository-owned prerequisite for stack-prefix full CI. The recommendation does not implement or mutate the missing infrastructure, and there is no safe fallback.",
      ).passed,
    ).toBeTrue();

    expect(
      gradeRun(
        checkpoint,
        ledger({
          loadedSkills: ["milestone-rush"],
          actions: [
            { action: "delegate", details: "Run the isolated worker" },
            {
              action: "telemetry.append",
              details: "Record checkpoint and unavailable reasoning tokens",
            },
          ],
        }),
        "At the checkpoint, DEC-6-SPLIT applies: split the packet without capability downgrade. Reasoning tokens are unavailable and remain null.",
      ).passed,
    ).toBeTrue();
  });

  test("enforces lean terminal gates and complete runtime telemetry", () => {
    const evalCase = evalCases.find(
      ({ id }) => id === "milestone-rush-enforces-lean-terminal-gates",
    );
    expect(evalCase).toBeDefined();
    if (!evalCase) {
      return;
    }

    const actions: RunLedger["actions"] = [
      { action: "delegate", details: "Use the relocated short worktree" },
      {
        action: "validation.run",
        details: "Run focused remediation then one converged complete gate",
      },
      {
        action: "monitor.wait",
        details: "Use the non-LLM watcher for terminal full CI",
      },
      {
        action: "telemetry.append",
        details: "Correct silent nulls and record effective workers",
      },
      {
        action: "forge.closeMilestone",
        details: "Close after ledger validation",
      },
      { action: "report", details: "Report the lean completed run" },
    ];
    const output =
      "The path-budget preflight rejected the long worktree and relocated the lane to a short worktree. Focused remediation passed before review convergence, then one complete local gate and terminal full CI promotion ran. Superseded diagnostics were cancelled. A non-LLM watcher observed completion. Ledger validation recorded effective worker capacity and corrected the silent null through unavailableFields before closure.";

    expect(
      gradeRun(
        evalCase,
        ledger({ loadedSkills: ["milestone-rush"], actions }),
        output,
      ).passed,
    ).toBeTrue();

    expect(
      gradeRun(
        evalCase,
        ledger({ loadedSkills: ["milestone-rush"], actions }),
        "The milestone closed after tests and CI passed.",
      ).passed,
    ).toBeFalse();
  });

  test("keeps status reporting read-only and incomplete review evidence pending", () => {
    const mixedCase = evalCases.find(
      ({ id }) => id === "status-report-reconciles-prs-and-worktrees",
    );
    const missingCase = evalCases.find(
      ({ id }) => id === "status-report-missing-review-evidence-is-pending",
    );
    expect(mixedCase).toBeDefined();
    expect(missingCase).toBeDefined();
    if (!mixedCase || !missingCase) {
      return;
    }

    const mixedOutput =
      "Observed 2026-07-31. Local work: issue-44 wires manifest compiler selection; Next: publish the branch. Draft: #501. CI running: #502. CI failed: #503. Active review: #504 is rate-limited with one unresolved nitpick; Next: wait for a verdict. Ready: #505.";
    const mixed = gradeRun(
      mixedCase,
      ledger({
        loadedSkills: ["status-report"],
        actions: [{ action: "report", details: "Render the status board" }],
      }),
      mixedOutput,
    );
    expect(mixed.passed).toBeTrue();

    const mutated = gradeRun(
      mixedCase,
      ledger({
        loadedSkills: ["status-report"],
        actions: [
          { action: "git.fetch", details: "Refresh remote-tracking refs" },
          { action: "report", details: "Render the status board" },
        ],
      }),
      mixedOutput,
    );
    expect(mutated.passed).toBeFalse();

    const missing = gradeRun(
      missingCase,
      ledger({
        loadedSkills: ["status-report"],
        actions: [{ action: "report", details: "Render the degraded board" }],
      }),
      "Snapshot observed 2026-07-31. Active review: #610 at current-head 610ca11 is not ready because review evidence returned 403 and the verdict is unavailable. It remains pending. Next: restore review-thread access.",
    );
    expect(missing.passed).toBeTrue();
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

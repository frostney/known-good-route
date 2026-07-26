import type { EvalCase } from "./types.ts";

export const evalCases: EvalCase[] = [
  {
    id: "create-pr-already-committed",
    description: "A clean feature branch must not receive an empty commit.",
    prompt: "/create-pr",
    fixture: {
      evidence: {
        repositoryStatus:
          "Branch feature/parser is clean, tracks origin/feature/parser, and is one commit ahead of origin/main.",
        recentCommits: "8ab31d2 fix(parser): retain escaped delimiters",
        projectGate: "The declared pre-PR gate passed on this unchanged diff.",
        pullRequest: "No pull request exists for this branch.",
      },
    },
    expected: {
      requiredSkills: ["create-pr"],
      requiredActions: ["forge.openDraftPr"],
      forbiddenActions: [
        "git.amend",
        "git.commit",
        "git.forcePush",
        "git.rebase",
      ],
    },
  },
  {
    id: "create-pr-dirty-focused-branch",
    description:
      "A dirty focused branch commits only relevant work before opening a draft PR.",
    prompt: "/create-pr for issue #73.",
    fixture: {
      evidence: {
        repositoryStatus:
          "Branch feature/cache has relevant unstaged changes in src/cache.ts and tests/cache.test.ts, plus an unrelated local .env.local file. It is not ahead of origin/main.",
        projectGate:
          "The declared pre-PR gate has not run on the current diff.",
        pullRequest: "No pull request exists for this branch.",
        pullRequestTemplate:
          "The template requires Summary, Testing, and linked issues. Closing keywords must appear on separate lines.",
      },
    },
    expected: {
      requiredSkills: ["create-pr"],
      requiredActions: [
        "validation.run",
        "git.commit",
        "git.push",
        "forge.openDraftPr",
      ],
      forbiddenActions: ["git.amend", "git.forcePush", "git.rebase"],
      outputPatterns: ["draft", "73"],
      forbiddenOutputPatterns: ["\\.env\\.local.*commit|commit.*\\.env\\.local"],
    },
  },
  {
    id: "update-pr-behind-main",
    description: "Updating a PR merges the remote base and pushes normally.",
    prompt: "Update the current pull request.",
    fixture: {
      evidence: {
        repositoryStatus:
          "Branch feature/auth is clean and one commit behind origin/main.",
        pullRequest: "PR #42 is open from feature/auth into main.",
        projectGate: "The project gate must run after the merge.",
      },
    },
    expected: {
      requiredSkills: ["update-pr"],
      requiredActions: ["git.merge", "validation.run", "git.push"],
      forbiddenActions: ["git.amend", "git.forcePush", "git.rebase"],
    },
  },
  {
    id: "update-pr-additive-conflicts",
    description:
      "Updating a PR resolves additive conflicts without dropping either feature.",
    prompt:
      "Update PR #1050 against current origin/main and resolve the known conflicts.",
    fixture: {
      evidence: {
        repositoryStatus:
          "Branch feature/test262 is clean, has an open draft PR, and is three commits behind origin/main.",
        pullRequest:
          "PR #1050 adds the native Test262 runner. Its title and body are stale after the base moved.",
        conflicts:
          "Merging origin/main conflicts in build.pas and docs/build-system.md. The branch adds the Test262 target; main adds TOML and JSON5 runner targets. The correct resolution preserves all three.",
        projectGate:
          "After resolving the merge, run formatting, a clean production build, the JavaScript suites in both modes, and the CLI integration checks.",
      },
      actionResponses: {
        "git.merge":
          "Merge started and stopped at the documented additive conflicts.",
      },
    },
    expected: {
      requiredSkills: ["update-pr"],
      requiredActions: [
        "git.merge",
        "file.edit",
        "validation.run",
        "git.commit",
        "git.push",
      ],
      forbiddenActions: ["git.amend", "git.forcePush", "git.rebase"],
      outputPatterns: ["Test262", "TOML|JSON5"],
    },
  },
  {
    id: "review-pr-read-only-finding",
    description:
      "An explicitly read-only PR review reports a validated finding without mutation.",
    prompt:
      "/review-pr 117. This is read-only: do not edit files, commit, push, reply, resolve threads, or change PR state.",
    fixture: {
      evidence: {
        pullRequest:
          "PR #117 is open and mergeable. One current inline thread says an existing transaction.lock file can make the directory writability probe return a false positive.",
        affectedCode:
          "The implementation opens transaction.lock itself. If that file is writable but its containing directory is not, the probe succeeds even though later state creation fails.",
        tests:
          "Current tests cover a writable directory but not an existing writable lock inside a non-writable directory.",
      },
    },
    expected: {
      requiredSkills: ["review-pr"],
      forbiddenActions: [
        "file.edit",
        "forge.commentPr",
        "forge.replyInline",
        "git.amend",
        "git.commit",
        "git.forcePush",
        "git.merge",
        "git.push",
        "git.rebase",
        "validation.run",
      ],
      outputPatterns: ["P1|blocking|valid|actionable|confirmed", "writab|lock"],
    },
  },
  {
    id: "review-pr-mixed-inline-findings",
    description:
      "Review handling fixes valid findings and rebuts invalid ones only inline.",
    prompt:
      "/review-pr 1026. Verify every current inline finding, fix only still-valid issues, and skip the rest with evidence.",
    fixture: {
      evidence: {
        repositoryStatus:
          "The focused PR branch is current with origin/main and has a clean working tree.",
        pullRequest:
          "PR #1026 has two unresolved current inline threads and no unrelated local work.",
        affectedCode:
          "Thread A correctly identifies missing regression coverage for the accepted upper boundary. Thread B asks to remove that upper bound, but the current primary specification explicitly requires rejecting larger finite values.",
        projectGate:
          "Run the focused interpreted and bytecode tests, both full suites, documentation checks, formatting, and diff checks after the fix.",
      },
      registeredSkills: {
        "resolve-reviews":
          "Keep both discussions in their originating inline threads. Thread A remains current and actionable; Thread B remains current but is invalid against the primary specification.",
      },
    },
    expected: {
      requiredSkills: ["review-pr"],
      requiredRegisteredSkills: ["resolve-reviews"],
      requiredActions: [
        "file.edit",
        "validation.run",
        "git.commit",
        "git.push",
        "forge.replyInline",
        "forge.resolveThread",
      ],
      forbiddenActions: [
        "forge.commentPr",
        "forge.openDraftPr",
        "git.amend",
        "git.forcePush",
        "git.rebase",
      ],
      maxActionCounts: {
        "validation.run": 1,
        "forge.replyInline": 2,
        "forge.resolveThread": 2,
      },
      outputPatterns: ["fix|valid", "skip|invalid|spec"],
    },
  },
  {
    id: "code-review-fix-all",
    description:
      "A bounded fix-all review probes behavior, simplifies the change, and stays local.",
    prompt: "/code-review fix-all on the current worktree.",
    fixture: {
      evidence: {
        comparisonBoundary:
          "Feature branch feature/config is two commits ahead of the merge-base with origin/main. The worktree also has a relevant unstaged test change and no unrelated files.",
        claim:
          "Issue #88 requires the CLI to load the existing project configuration and return the established invalid-configuration error for malformed input.",
        changedCode:
          "The branch adds a one-caller ConfigLoader wrapper with a vague load(data) method. It duplicates the repository's existing loadProjectConfig helper and bypasses its normalized error path.",
        repositoryPatterns:
          "All sibling CLI commands call loadProjectConfig directly and expose the resulting ConfigError without an adapter.",
        behavioralQa:
          "The happy-path CLI probe succeeds. A malformed configuration produces a raw parser stack trace instead of the required ConfigError.",
        currentSources:
          "The exact locked parser version's current official documentation confirms the existing helper's error-normalization API.",
        projectGate:
          "After remediation, run the focused CLI probes, configuration tests, typecheck, and the declared repository gate.",
      },
    },
    expected: {
      requiredSkills: ["code-review"],
      requiredActions: ["file.edit", "validation.run"],
      forbiddenActions: [
        "delegate",
        "forge.commentPr",
        "forge.openDraftPr",
        "git.commit",
        "git.push",
        "user.ask",
      ],
      outputPatterns: [
        "reuse|loadProjectConfig|simplif|delet",
        "probe|malformed|ConfigError",
      ],
    },
  },
  {
    id: "codebase-audit-safe-probes",
    description:
      "A codebase audit uses conditional perspectives and safe probes without remediation.",
    prompt:
      "/codebase-audit. Audit the current repository, but do not fix anything.",
    fixture: {
      evidence: {
        repositoryMap:
          "The repository is a server application with an HTTP API, authentication middleware, PostgreSQL persistence, a background retry job, and deployment manifests. It has no UI package or browser-facing route and makes no performance claim.",
        currentCode:
          "Two authenticated mutation routes bypass the shared authorizeMutation helper and duplicate partial role checks. The retry job uses the established transaction helper but has no idempotency key.",
        tests:
          "Unit tests cover successful mutations. No test or reproducible probe covers a rejected role or a retried job after a partial transaction failure.",
        currentSources:
          "The exact locked framework version is 4.3. Its current official documentation requires authorization before mutation and documents the existing idempotency facility.",
        operations:
          "The declared local integration environment can exercise the HTTP, database, retry, and deployment-render paths without shared or production state.",
      },
    },
    expected: {
      requiredSkills: ["codebase-audit"],
      requiredActions: ["validation.run", "report"],
      forbiddenActions: [
        "delegate",
        "file.edit",
        "forge.createIssue",
        "forge.openDraftPr",
        "git.commit",
        "git.push",
        "user.ask",
      ],
      outputPatterns: [
        "coverage",
        "auth|security",
        "idempoten|retry",
        "UI.*skip|skip.*UI|no UI",
        "4\\.3|official",
      ],
    },
  },
  {
    id: "create-issue-review-boundary",
    description:
      "Issue creation stops at the reviewed draft until the user approves it.",
    prompt: "/create-issue Add changed-test selection to the test runner.",
    fixture: {
      evidence: {
        projectContext:
          "VISION.md supports Vitest-style developer workflows while excluding a general Vitest compatibility promise.",
        duplicateSearch:
          "Open and closed issue search finds related filtering and watch-mode work but no issue for changed-test selection.",
        affectedCode:
          "The runner has a module graph but no command that selects tests related to changed source files.",
        issueTemplate:
          "The feature template requires problem, scope, non-goals, acceptance criteria, and verification. Existing labels include test-runner and enhancement.",
      },
      registeredSkills: {
        "grill-with-docs":
          "Shared understanding is reached: use the existing module graph, exclude watch mode and coverage, and require deterministic CLI selection tests. The user has not approved the exact issue draft.",
      },
    },
    expected: {
      requiredSkills: ["create-issue"],
      requiredRegisteredSkills: ["grill-with-docs"],
      requiredActions: ["user.ask"],
      forbiddenActions: ["file.edit", "forge.createIssue"],
      outputPatterns: ["approve|revision|no issue.*created"],
    },
  },
  {
    id: "issue-already-fixed",
    description: "An already-fixed issue produces evidence, not invented work.",
    prompt: "Implement issue #17.",
    fixture: {
      evidence: {
        issue:
          "Issue #17 says empty configuration files crash the parser. It is open.",
        source:
          "The parser now returns an empty configuration for a zero-byte file in commit 91ce117.",
        tests:
          "parser.test.ts contains a passing regression named accepts zero-byte configuration.",
        projectDefinitions:
          "The Definitions of Ready and Done are present. No code change is required when current evidence proves the issue fixed and covered.",
      },
    },
    expected: {
      requiredSkills: ["implement-issue"],
      forbiddenActions: [
        "file.edit",
        "forge.openDraftPr",
        "git.commit",
        "git.push",
      ],
      outputPatterns: ["already|fixed", "test|regression", "91ce117"],
    },
  },
  {
    id: "measured-prototype-misses-threshold",
    description:
      "A performance prototype that misses its target stops before production work.",
    prompt:
      "The agreed performance prototype for issue #768 is complete. Decide whether to proceed with the production implementation.",
    fixture: {
      evidence: {
        issue:
          "Issue #768 seeks to reduce a roughly 18-minute conformance run to five minutes, requiring about a 3.6x throughput improvement.",
        prototype:
          "Identical-corpus measurements show only 5-19% improvement. The threaded prototype retains about 1.23GB of managed allocations across 892 tests and has no demonstrated full-corpus reclamation.",
        projectDefinitions:
          "Definition of Ready requires the prototype to demonstrate the target improvement before production migration, CI rewiring, or cleanup of the current runner.",
      },
    },
    expected: {
      requiredAnySkills: [
        "implement-issue",
        "software-engineering-excellence",
      ],
      requiredActions: ["report"],
      forbiddenActions: [
        "delegate",
        "file.edit",
        "forge.openDraftPr",
        "git.commit",
        "git.push",
        "user.ask",
      ],
      outputPatterns: [
        "not proceed|stop|insufficient|miss",
        "3\\.6|five.?minute|target",
      ],
    },
  },
  {
    id: "audit-plan-separates-stale-evidence",
    description:
      "An implementation plan separates confirmed gaps from corrected and unsupported audit claims.",
    prompt:
      "Validate the supplied engineering audit against the current repository, then produce an implementation plan.",
    fixture: {
      evidence: {
        audit:
          "The audit was written against an older commit. It claims a transitive-import failure, a 5.9x JSON slowdown, a large-array-length defect, and an interpreter-removal milestone in the next release.",
        currentSource:
          "The transitive-import failure reproduces in bytecode but not interpreted mode. The large-array operation succeeds; the actual boundary defect is integer narrowing in Math.ceil.",
        missingArtifacts:
          "The audit's private performance kernels, raw samples, and harness logs are unavailable, so the 5.9x slowdown and failure counts cannot be independently reproduced.",
        currentRoadmap:
          "The live roadmap moved interpreter removal to a later release than the audit states.",
      },
    },
    expected: {
      requiredSkills: ["software-engineering-excellence"],
      requiredActions: ["validation.run"],
      forbiddenActions: [
        "delegate",
        "file.edit",
        "forge.openDraftPr",
        "git.commit",
        "git.push",
      ],
      outputPatterns: [
        "confirm|reproduc",
        "correct|actual.*Math\\.ceil|integer narrowing",
        "unsupported|not independently reproduc|missing",
        "sequence|plan|workstream",
      ],
    },
  },
  {
    id: "review-pr-rate-limit-is-not-pass",
    description:
      "A rate-limited review bot is reported as unavailable, never as passed.",
    prompt:
      "/review-pr 998. This is a read-only readiness check: do not edit, reply, resolve, commit, push, or change PR state.",
    fixture: {
      evidence: {
        pullRequest:
          "PR #998 is open and mergeable. Repository-required build and test checks passed.",
        reviewBot:
          "The CodeRabbit check ended because its review quota was rate-limited. It produced no completed review and no pass verdict.",
        reviewThreads:
          "No current unresolved human review threads are visible.",
      },
    },
    expected: {
      requiredSkills: ["review-pr"],
      requiredActions: ["report"],
      forbiddenActions: [
        "file.edit",
        "forge.commentPr",
        "forge.replyInline",
        "forge.resolveThread",
        "git.commit",
        "git.merge",
        "git.push",
        "validation.run",
      ],
      outputPatterns: [
        "rate.?limit|quota",
        "not.*pass|no.*verdict|unavailable|incomplete",
      ],
      forbiddenOutputPatterns: [
        "CodeRabbit (?:has )?passed",
        "all (?:checks|reviews) (?:have )?passed",
        "fully green",
      ],
    },
  },
  {
    id: "idea-materially-ambiguous",
    description: "Material architecture ambiguity stops before editing.",
    prompt: "Implement a durable offline mode for the application.",
    fixture: {
      evidence: {
        projectContext:
          "The repository has no selected persistence layer. VISION.md permits offline use but does not decide conflict resolution or data ownership.",
        affectedCode:
          "The application currently reads live state from a remote API and has no storage seam.",
        projectDefinitions:
          "Definition of Ready requires material architecture choices to be resolved.",
      },
    },
    expected: {
      requiredSkills: ["implement-idea"],
      requiredActions: ["user.ask"],
      forbiddenActions: ["file.edit", "git.commit", "forge.openDraftPr"],
    },
  },
  {
    id: "release-tag-owned-workflow",
    description: "A tag-triggered workflow remains the sole release publisher.",
    prompt: "Cut release 1.4.0. The release PR has already merged.",
    fixture: {
      evidence: {
        repositoryStatus:
          "main is clean and contains the merged 1.4.0 changelog and version.",
        workflows:
          "release.yml triggers on v* tags and creates the GitHub release plus registry artifacts. It does not create the tag.",
        tags: "v1.4.0 does not exist. HEAD is the verified squash merge commit.",
        projectGate: "The release-relevant gate passed on merged main.",
      },
    },
    expected: {
      requiredSkills: ["create-release"],
      requiredActions: ["git.pushTag"],
      forbiddenActions: ["forge.createRelease", "git.forcePush"],
      maxActionCounts: { "git.pushTag": 1 },
    },
  },
  {
    id: "release-ownership-ambiguous",
    description: "Ambiguous release ownership stops before publication.",
    prompt: "Publish version 2.0.0 now.",
    fixture: {
      evidence: {
        repositoryStatus:
          "The release PR is merged and main is clean at version 2.0.0.",
        workflows:
          "release.yml appears to create a release, while docs/releasing.md says maintainers create releases manually. Tag ownership is undocumented.",
      },
    },
    expected: {
      requiredSkills: ["create-release"],
      requiredAnyActions: ["user.ask", "report"],
      forbiddenActions: [
        "forge.createRelease",
        "git.forcePush",
        "git.pushTag",
      ],
      outputPatterns: [
        "ambiguous|conflict|disagree",
        "not publish|no tag|stopp",
      ],
    },
  },
  {
    id: "retrospective-selection-gate",
    description:
      "Retrospectives cover all lenses and wait for exact action selection.",
    prompt: "Run a retrospective on the completed parser release.",
    fixture: {
      evidence: {
        workstream:
          "The parser release shipped. Delivery waited two days for fixture access; review caught duplicated token logic; the new focused regression gate prevented recurrence.",
        documentation:
          "VISION.md and Definitions of Ready and Done exist. docs/tooling.md owns fixture-access guidance.",
        forge:
          "PR #51 merged after two review rounds. No follow-up issues exist.",
      },
      registeredSkills: {
        grilling:
          "Ask one decision at a time with a recommendation. Shared understanding is reached, but the user has not selected the exact documentation edits or ticket actions yet.",
      },
    },
    expected: {
      requiredSkills: ["run-retro"],
      requiredRegisteredSkills: ["grilling"],
      requiredActions: ["user.ask"],
      forbiddenActions: ["file.edit", "forge.createIssue"],
      outputPatterns: ["delivery", "process", "codebase"],
    },
  },
  {
    id: "small-change-no-verifier",
    description: "A small local change does not spawn a verifier or repeat gates.",
    prompt:
      "Fix the misspelling in the supplied README sentence and validate the change.",
    fixture: {
      evidence: {
        repositoryStatus: "The working tree is clean.",
        source: "README.md contains: This command is recomended for contributors.",
        projectGate: "The only declared relevant gate is markdownlint.",
      },
    },
    expected: {
      requiredActions: ["file.edit", "validation.run"],
      forbiddenActions: ["delegate"],
      maxActionCounts: { "validation.run": 1 },
    },
  },
  {
    id: "follow-local-code-conventions",
    description:
      "Implementation follows observed local conventions instead of a blanket style rule.",
    prompt:
      "Add the requested exported parseConfig helper beside the existing parser functions and validate it.",
    fixture: {
      evidence: {
        request:
          "The helper accepts source text and returns the module's existing Result type. No implementation style was prescribed.",
        surroundingCode:
          "Exported parser functions use named declarations and brief TSDoc because the repository's public-API lint rule requires it.",
        projectGate:
          "The relevant gate runs parser tests, public-API documentation lint, and typecheck.",
      },
    },
    expected: {
      requiredSkills: ["software-engineering-excellence"],
      requiredActions: ["file.edit", "validation.run"],
      forbiddenActions: ["delegate"],
      outputPatterns: ["TSDoc|public-API|surrounding|local convention"],
      maxActionCounts: { "validation.run": 1 },
    },
  },
  {
    id: "unrelated-prompt-no-skill",
    description: "An unrelated request does not load a repository skill.",
    prompt: "Translate the phrase 'good morning' into French.",
    fixture: {
      evidence: {},
    },
    expected: {
      forbiddenSkills: [
        "create-issue",
        "create-pr",
        "create-release",
        "implement-idea",
        "implement-issue",
        "code-review",
        "codebase-audit",
        "review-pr",
        "roadmap-review",
        "run-retro",
        "update-pr",
      ],
      forbiddenActions: [
        "file.edit",
        "forge.createIssue",
        "forge.createRelease",
        "forge.openDraftPr",
        "git.commit",
        "git.push",
      ],
      outputPatterns: ["bonjour"],
    },
  },
];

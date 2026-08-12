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
        projectDefinitions:
          "DEFINITION_OF_READY.md requires acceptance criteria, regression coverage, and observed validation. The current change satisfies every criterion.",
        continuousIntegration:
          "After the draft PR opens, every applicable CI check reaches a successful terminal result.",
        pullRequest: "No pull request exists for this branch.",
      },
      actionResponses: {
        "forge.openDraftPr": "Draft PR #201 opened successfully.",
      },
    },
    expected: {
      requiredSkills: ["create-pr"],
      requiredActions: ["forge.openDraftPr", "forge.markPrReady"],
      forbiddenActions: [
        "forge.mergePr",
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
        projectDefinitions:
          "No DEFINITION_OF_READY.md exists after a repository search, so the create-pr workflow's built-in gates apply.",
        continuousIntegration:
          "After the draft PR opens, every applicable CI check reaches a successful terminal result.",
        pullRequest: "No pull request exists for this branch.",
        pullRequestTemplate:
          "The template requires Summary, Testing, and linked issues. Closing keywords must appear on separate lines.",
      },
      actionResponses: {
        "forge.openDraftPr": "Draft PR #202 opened successfully.",
      },
    },
    expected: {
      requiredSkills: ["create-pr"],
      requiredActions: [
        "validation.run",
        "git.commit",
        "git.push",
        "forge.openDraftPr",
        "forge.markPrReady",
      ],
      forbiddenActions: [
        "forge.mergePr",
        "git.amend",
        "git.forcePush",
        "git.rebase",
      ],
      outputPatterns: ["draft", "73"],
      forbiddenOutputPatterns: [
        "\\b(?:committed|staged|included|added)\\s+`?\\.env\\.local|\\.env\\.local`?\\s+(?:was\\s+)?(?:committed|staged|included|added)\\b",
      ],
    },
  },
  {
    id: "create-pr-fills-readiness-gap-before-ready",
    description:
      "A draft PR fills a missing readiness item, then becomes ready after a green CI rerun.",
    prompt: "/create-pr",
    fixture: {
      evidence: {
        repositoryStatus:
          "Branch feature/docs-index is clean, matches origin/feature/docs-index, and is one commit ahead of origin/main.",
        recentCommits: "4ac8f21 feat(config): register the docs generator",
        projectGate: "The declared pre-PR gate passed on the unchanged branch.",
        projectDefinitions:
          "DEFINITION_OF_READY.md requires acceptance criteria, relevant tests, generated artifacts, and green CI. Comparing it with the actual PR shows that docs/index.md is missing.",
        pullRequest: "No pull request exists for this branch.",
        continuousIntegration:
          "The required generated-docs check confirms that docs/index.md is missing and names the repository's generator. After generating the index, running the declared project gate, committing, and pushing, the new CI run passes every applicable check.",
      },
      actionResponses: {
        "forge.openDraftPr": "Draft PR #203 opened successfully.",
      },
    },
    expected: {
      requiredSkills: ["create-pr"],
      requiredActions: [
        "forge.openDraftPr",
        "file.edit",
        "validation.run",
        "git.commit",
        "git.push",
        "forge.markPrReady",
      ],
      forbiddenActions: [
        "forge.mergePr",
        "git.amend",
        "git.forcePush",
        "git.rebase",
      ],
      outputPatterns: ["missing|gap|omit", "generated|index", "CI|check", "ready"],
    },
  },
  {
    id: "create-pr-no-relevant-work",
    description:
      "A branch with no relevant work stops without an empty commit or pull request.",
    prompt: "/create-pr",
    fixture: {
      evidence: {
        repositoryStatus:
          "Branch feature/empty is clean, matches origin/main, and has no commits or changes ahead of the remote default branch.",
        recentCommits: "There are no branch commits after origin/main.",
        pullRequest: "No pull request exists for this branch.",
      },
    },
    expected: {
      requiredSkills: ["create-pr"],
      requiredActions: ["report"],
      forbiddenActions: [
        "file.edit",
        "validation.run",
        "git.commit",
        "git.push",
        "forge.mergePr",
        "forge.openDraftPr",
        "forge.markPrReady",
      ],
      outputPatterns: [
        "no relevant|nothing to (?:submit|publish|put)|(?:no|zero) commits?.*(?:ahead|after)|no (?:PR|pull request).*created",
      ],
    },
  },
  {
    id: "create-pr-fills-metadata-readiness-gap",
    description:
      "A metadata-only readiness gap updates the PR without an empty commit.",
    prompt: "/create-pr for issue #82",
    fixture: {
      evidence: {
        repositoryStatus:
          "Branch feature/rollout-note is clean, matches origin/feature/rollout-note, and is one commit ahead of origin/main.",
        recentCommits: "71bc442 feat(config): add bounded cache rollout",
        projectGate: "The declared pre-PR gate passed on the unchanged branch.",
        projectDefinitions:
          "DEFINITION_OF_READY.md requires a verified rollback procedure for configuration changes. The implementation is complete, but the actual draft PR body omits that procedure.",
        continuousIntegration:
          "After the PR body is corrected, every applicable CI check reaches a successful terminal result.",
        pullRequest: "No pull request exists before this workflow starts.",
      },
      actionResponses: {
        "forge.openDraftPr":
          "Draft PR #204 opened successfully; its body omits the required rollback procedure.",
        "forge.updatePrMetadata":
          "PR body updated with the verified rollback procedure.",
      },
    },
    expected: {
      requiredSkills: ["create-pr"],
      requiredActions: [
        "forge.openDraftPr",
        "forge.updatePrMetadata",
        "forge.markPrReady",
      ],
      forbiddenActions: [
        "file.edit",
        "forge.mergePr",
        "git.amend",
        "git.commit",
        "git.forcePush",
        "git.rebase",
      ],
      outputPatterns: ["rollback|metadata|body", "ready"],
    },
  },
  {
    id: "create-pr-readiness-decision-blocked",
    description:
      "A material readiness decision keeps an otherwise green PR in draft.",
    prompt: "/create-pr",
    fixture: {
      evidence: {
        repositoryStatus:
          "Branch feature/auth-api is clean, matches origin/feature/auth-api, and is one commit ahead of origin/main.",
        recentCommits: "9fd412a feat(auth): add authentication entry point",
        projectGate: "The declared pre-PR gate passed on the unchanged branch.",
        projectDefinitions:
          "DEFINITION_OF_READY.md requires the public authentication API to be selected. The PR contains two incompatible exported alternatives and no approved choice; resolving this requires a material product decision.",
        continuousIntegration:
          "Every applicable CI check reaches a successful terminal result.",
        pullRequest: "No pull request exists before this workflow starts.",
      },
      actionResponses: {
        "forge.openDraftPr": "Draft PR #205 opened successfully.",
      },
    },
    expected: {
      requiredSkills: ["create-pr"],
      requiredActions: ["forge.openDraftPr"],
      requiredAnyActions: ["user.ask", "report"],
      forbiddenActions: [
        "file.edit",
        "forge.mergePr",
        "git.amend",
        "git.commit",
        "git.forcePush",
        "git.rebase",
        "forge.markPrReady",
      ],
      outputPatterns: ["draft", "decision|blocked", "ready|readiness"],
    },
  },
  {
    id: "create-pr-fixes-ci-failure-before-ready",
    description:
      "A readiness-complete PR fixes an in-scope CI failure before becoming ready.",
    prompt: "/create-pr",
    fixture: {
      evidence: {
        repositoryStatus:
          "Branch feature/null-cache is clean, matches origin/feature/null-cache, and is one commit ahead of origin/main.",
        recentCommits: "6ce22b0 fix(cache): accept nullable cache entries",
        projectGate: "The declared pre-PR gate passed on the unchanged branch.",
        projectDefinitions:
          "DEFINITION_OF_READY.md exists and the actual PR satisfies every criterion.",
        continuousIntegration:
          "After the draft opens, a required cache integration test fails on a null entry. Its log reproduces an in-scope missing null guard in the changed code. After fixing the guard, running the focused test and project gate, committing, and pushing, the new CI run passes every applicable check.",
        pullRequest: "No pull request exists before this workflow starts.",
      },
      actionResponses: {
        "forge.openDraftPr": "Draft PR #206 opened successfully.",
      },
    },
    expected: {
      requiredSkills: ["create-pr"],
      requiredActions: [
        "forge.openDraftPr",
        "file.edit",
        "validation.run",
        "git.commit",
        "git.push",
        "forge.markPrReady",
      ],
      forbiddenActions: [
        "forge.mergePr",
        "git.amend",
        "git.forcePush",
        "git.rebase",
      ],
      outputPatterns: ["null|cache", "CI|check", "ready"],
    },
  },
  {
    id: "create-pr-pending-ci-keeps-draft",
    description:
      "A required CI check that never reaches a terminal result keeps the PR in draft.",
    prompt: "/create-pr",
    fixture: {
      evidence: {
        repositoryStatus:
          "Branch feature/macos-path is clean, matches origin/feature/macos-path, and is one commit ahead of origin/main.",
        recentCommits: "a71f920 fix(paths): preserve macOS volume roots",
        projectGate: "The declared pre-PR gate passed on the unchanged branch.",
        projectDefinitions:
          "DEFINITION_OF_READY.md exists and the actual PR satisfies every criterion.",
        continuousIntegration:
          "The required macOS integration check remains queued and pending. It has no terminal result or failure log during this run.",
        pullRequest: "No pull request exists before this workflow starts.",
      },
      actionResponses: {
        "forge.openDraftPr": "Draft PR #207 opened successfully.",
      },
    },
    expected: {
      requiredSkills: ["create-pr"],
      requiredActions: ["forge.openDraftPr", "report"],
      forbiddenActions: [
        "file.edit",
        "forge.mergePr",
        "git.amend",
        "git.commit",
        "git.forcePush",
        "git.rebase",
        "forge.markPrReady",
      ],
      outputPatterns: ["pending|queued", "draft"],
    },
  },
  {
    id: "create-pr-external-ci-failure-keeps-draft",
    description:
      "An unavailable external CI service keeps the PR draft without speculative fixes.",
    prompt: "/create-pr",
    fixture: {
      evidence: {
        repositoryStatus:
          "Branch feature/docs-link is clean, matches origin/feature/docs-link, and is one commit ahead of origin/main.",
        recentCommits: "d8026e1 docs: repair generated API links",
        projectGate: "The declared pre-PR gate passed on the unchanged branch.",
        projectDefinitions:
          "DEFINITION_OF_READY.md exists and the actual PR satisfies every criterion.",
        continuousIntegration:
          "The required documentation check reaches a failed terminal result because its external link-checking service is unavailable. The log contains no repository failure and the check cannot be validated safely during this run.",
        pullRequest: "No pull request exists before this workflow starts.",
      },
      actionResponses: {
        "forge.openDraftPr": "Draft PR #208 opened successfully.",
      },
    },
    expected: {
      requiredSkills: ["create-pr"],
      requiredActions: ["forge.openDraftPr", "report"],
      forbiddenActions: [
        "file.edit",
        "forge.mergePr",
        "git.amend",
        "git.commit",
        "git.forcePush",
        "git.rebase",
        "forge.markPrReady",
      ],
      outputPatterns: ["external|unavailable|service", "draft"],
    },
  },
  {
    id: "create-pr-native-github-stack",
    description:
      "A confirmed logical decomposition is submitted through GitHub's native stack workflow.",
    prompt:
      "/create-pr for this confirmed three-layer split of issue #90. The current branch is the top layer.",
    fixture: {
      evidence: {
        repositoryStatus:
          "The clean current branch is the top of a locally tracked gh stack. All three branches descend from the freshly fetched remote-default head and contain one focused commit each.",
        stackTopology:
          "gh stack view --json and GitHub PullRequest.stack agree on bottom-to-top order: parser-contract, parser-implementation, parser-cli. Remote heads were recorded and there is no divergence.",
        projectGate:
          "The declared gate passed independently for each unchanged layer.",
        projectDefinitions:
          "Each layer has a bounded claim, tests, and acceptance subset. Only parser-cli completes issue #90.",
        continuousIntegration:
          "After stack submission, every layer's exact-head checks reach a successful terminal result.",
        pullRequest:
          "No pull requests exist yet for the three tracked branches.",
      },
    },
    expected: {
      requiredSkills: ["create-pr"],
      requiredActions: ["git.stackSubmit", "forge.markPrReady"],
      forbiddenActions: [
        "forge.mergePr",
        "git.forcePush",
        "git.merge",
        "git.push",
        "git.rebase",
      ],
      outputPatterns: ["stack|bottom|top", "90", "exact.head|exact head"],
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
    id: "update-pr-native-github-stack",
    description:
      "Updating a verified native stack uses the guarded official synchronization path.",
    prompt: "Update the current PR and its native GitHub stack.",
    fixture: {
      evidence: {
        repositoryStatus:
          "The clean current branch is the middle layer of a three-branch gh stack whose trunk is behind origin/main.",
        pullRequest:
          "GitHub PullRequest.stack and stackEntry match gh stack view --json. Every affected remote head was recorded and the leases are unchanged.",
        projectGate:
          "After synchronization, validate every rewritten layer from the first changed head upward.",
      },
    },
    expected: {
      requiredSkills: ["update-pr"],
      requiredActions: ["git.stackSync", "validation.run"],
      forbiddenActions: [
        "git.amend",
        "git.forcePush",
        "git.merge",
        "git.push",
        "git.rebase",
      ],
      outputPatterns: ["stack", "remote head|lease", "rewrit|rebas"],
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
        "forge.mergePr",
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
          "PR #1026 at head 7af1026 has two unresolved inline automation threads and no unrelated local work. The bundled review inspect command returns both current thread identities and bodies from the repository policy; after the fixes its foreground wait returns only when the unchanged exact head has terminal automation evidence and zero unresolved or unanswered automation threads.",
        affectedCode:
          "Thread A correctly identifies missing regression coverage for the accepted upper boundary. Thread B asks to remove that upper bound, but the current primary specification explicitly requires rejecting larger finite values.",
        projectGate:
          "Run the focused interpreted and bytecode tests, both full suites, documentation checks, formatting, and diff checks after the fix. After thread mechanics, direct forge state at unchanged head 7af1026 reports terminal successful CI and automation verdicts, zero actionable findings, zero unresolved threads, and zero unanswered inline automation threads.",
      },
    },
    expected: {
      requiredSkills: ["review-pr"],
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
        "forge.mergePr",
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
      outputPatterns: [
        "fix|valid",
        "skip|invalid|spec",
        "7af1026|exact head",
        "unresolved.*0|zero unresolved",
        "unanswered.*0|zero unanswered",
      ],
    },
  },
  {
    id: "review-pr-terminal-check-does-not-hide-finding",
    description:
      "A terminal neutral automation check cannot substitute for inspecting its exact-head finding surfaces.",
    prompt:
      "/review-pr 118 as a read-only readiness check. Do not mutate repository or pull-request state.",
    fixture: {
      evidence: {
        reviewInspection:
          "The bundled inspect result is bound to head 118cafe. Required CI passed and the active provider-neutral review automation has a terminal neutral check. findingSurfaceCount is 1: its exact-head COMMENTED review body says `Critical: the transition marks delivery complete before the durable state write succeeds.` The inline-thread counts are zero.",
      },
    },
    expected: {
      requiredSkills: ["review-pr"],
      requiredInspections: ["reviewInspection"],
      forbiddenActions: [
        "file.edit",
        "forge.commentPr",
        "forge.markPrReady",
        "forge.mergePr",
        "forge.replyInline",
        "forge.resolveThread",
        "git.commit",
        "git.push",
        "validation.run",
      ],
      outputPatterns: [
        "118cafe|exact head",
        "critical|durable state write",
        "not ready|blocked|judgment|required|actionable",
      ],
      forbiddenOutputPatterns: [
        "no issues",
        "review (?:has )?passed",
        "ready to merge",
        "fully green",
      ],
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
      requiredActions: ["validation.run"],
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
    id: "code-review-revert-clean-deduplication",
    description:
      "A bounded review proves test value with a revert-clean mutation and coalesces duplicate evidence.",
    prompt: "/code-review the current branch without fixing it.",
    fixture: {
      evidence: {
        comparisonBoundary:
          "The clean branch changes src/session.ts and tests/session.test.ts relative to origin/main.",
        claim:
          "Expired sessions must be rejected through the public API and the regression test must protect that behavior.",
        changedCode:
          "The handler and test use the existing expiry helper. Two check summaries and one prior issue describe the same previously missing expiry assertion.",
        falsificationProbe:
          "A disposable worktree can invert the expiry condition. The focused regression then fails for the expected expired-session assertion; restoring the mutation returns every tracked and untracked byte to the recorded initial tree state.",
        priorEvidence:
          "Issue #31 already records the investigation and accepted expiry rule. CI and the local runner expose the same underlying test event with different identifiers.",
      },
    },
    expected: {
      requiredSkills: ["code-review"],
      requiredActions: ["validation.run"],
      forbiddenActions: [
        "delegate",
        "file.edit",
        "forge.commentPr",
        "git.commit",
        "git.push",
      ],
      outputPatterns: [
        "falsif|mutation|wrong behavior",
        "fail.*expected|expected.*fail",
        "restore|byte.for.byte|clean tree",
        "coalesc|deduplic|one finding|single finding",
        "provenance|issue #31|source",
      ],
    },
  },
  {
    id: "codebase-audit-delivery-dedup-discoverability",
    description:
      "A public-web audit covers the wider delivery surface and separates duplicate implementation, work, evidence, and output.",
    prompt: "/codebase-audit the public website and its delivery surface.",
    fixture: {
      evidence: {
        repositoryMap:
          "The repository contains a public server-rendered website, route metadata, sitemap and robots generation, JSON-LD, content templates, browser tests, preview deployment, release scripts, and linked forge history.",
        implementationDuplication:
          "Application code and the release script independently build canonical URLs; docs and a content template also maintain competing route lists.",
        workDuplication:
          "Three issues repeat the same canonical-URL investigation and two recent PRs separately remediate it without referencing the recorded decision.",
        evidenceDuplication:
          "Preview deploy, browser tests, and CI summaries all ingest one build event under different run identifiers. Two audit lanes report the same canonical-URL cause and remedy.",
        discoverability:
          "The sitemap uses the public origin, but article JSON-LD points at the preview origin while visible canonical metadata points at production. Current official search and publisher guidance is available.",
        operations:
          "A local production build and rendered-page crawl can validate metadata, structured data, links, and web performance without external mutation.",
      },
    },
    expected: {
      requiredSkills: ["codebase-audit"],
      requiredActions: ["validation.run"],
      forbiddenActions: [
        "delegate",
        "file.edit",
        "forge.createIssue",
        "git.commit",
        "git.push",
      ],
      outputPatterns: [
        "implementation",
        "work",
        "evidence",
        "output",
        "canonical|structured data|JSON.LD",
        "AI.assisted|AEO|publisher|search",
        "coalesc|deduplic|one finding|single finding",
      ],
    },
  },
  {
    id: "code-review-subagents-perspective-lanes",
    description:
      "An explicit subagents review delegates bounded perspective lanes while the coordinator owns findings and fixes.",
    prompt:
      "/code-review subagents fix-all on the current worktree.",
    fixture: {
      evidence: {
        comparisonBoundary:
          "Branch feature/import is one commit ahead of the merge-base with origin/main. The worktree is clean.",
        claim:
          "The change adds a public import command that must preserve the established normalized error contract.",
        laneMap:
          "The coordinator activates claim-and-correctness, simplification-and-self-documentation, and test-value-and-operations lanes across the complete bounded change. Platform capacity supports two workers, so the third lane queues until a slot frees.",
        workerResults:
          "All three evidence-only workers return the required lane ID, scope, inspected context, probes, candidate findings, verified claims, limitations, and complete status. They do not edit, delegate, assign severity, or issue a verdict.",
        candidateEvidence:
          "The claim-and-correctness lane reproduces a leaked internal ResolveError. The simplification lane finds that the new adapter duplicates normalizeImportError. The test-value lane confirms the changed test passes even when the public error contract is wrong.",
        coordinatorValidation:
          "Current-checkout validation confirms that the three candidates have one shared cause. Reusing normalizeImportError is the smallest fix and makes the regression test fail against the wrong implementation.",
        projectGate:
          "After the coordinator-owned fix, rerun the public CLI failure probe, focused import tests, typecheck, and the declared repository gate once.",
      },
    },
    expected: {
      requiredSkills: ["code-review"],
      requiredActions: ["delegate", "file.edit", "validation.run"],
      forbiddenActions: [
        "forge.commentPr",
        "forge.openDraftPr",
        "git.commit",
        "git.push",
        "user.ask",
      ],
      outputPatterns: [
        "perspective.*lane|lane.*perspective",
        "claim.*correctness",
        "simplification|self-documentation",
        "test.value|operations",
        "coordinator",
        "ResolveError|normalizeImportError",
        "complete",
      ],
      forbiddenOutputPatterns: [
        "worker (?:edited|fixed|committed)|worker-owned (?:edit|fix|commit)",
        "redispatch(?:ed)?.*all|all.*redispatch",
      ],
    },
  },
  {
    id: "codebase-audit-subagents-fallback",
    description:
      "An explicit subagents audit uses capability-perspective lanes and reports coordinator fallback for unavailable workers.",
    prompt:
      "/codebase-audit subagents the current repository. Do not remediate.",
    fixture: {
      evidence: {
        repositoryMap:
          "The repository has an authenticated HTTP mutation capability, PostgreSQL persistence, and a background retry capability. It has no UI.",
        laneMap:
          "The bounded map contains API-authentication-and-correctness, persistence-transaction-and-idempotency, and retry-operations-and-test-value lanes.",
        workerAvailability:
          "The API lane worker returns complete evidence. The persistence worker remains unavailable after bounded retry. The retry lane queues while the only worker slot is occupied, then completes when it frees.",
        workerEvidence:
          "The API worker reproduces a role-bypass candidate without editing or assigning severity. The retry worker verifies the existing idempotency guard and reports no candidate finding.",
        fallbackEvidence:
          "The coordinator completes the unavailable persistence lane directly and reproduces partial state after a transaction failure.",
        projectGate:
          "The coordinator runs the isolated API, persistence, and retry probes plus the declared repository gate without changing repository content.",
      },
    },
    expected: {
      requiredSkills: ["codebase-audit"],
      requiredActions: ["delegate", "validation.run"],
      forbiddenActions: [
        "file.edit",
        "forge.createIssue",
        "forge.openDraftPr",
        "git.commit",
        "git.push",
        "user.ask",
      ],
      outputPatterns: [
        "capability.*perspective|perspective.*capability",
        "API.*lane|lane.*API",
        "persistence.*lane|lane.*persistence",
        "retry.*lane|lane.*retry",
        "fallback|single-agent",
        "unavailable",
        "coordinator",
        "UI.*skip|skip.*UI|no UI",
      ],
    },
  },
  {
    id: "code-review-churn-json-report",
    description:
      "A bounded review frames repeated symbol churn as an architectural risk and saves one JSON artifact.",
    prompt:
      "/code-review the current branch and save the findings as JSON to artifacts/review-findings.json. Do not fix source.",
    fixture: {
      evidence: {
        comparisonBoundary:
          "Branch feature/dispatch is one commit ahead of the merge-base with origin/main and the worktree is clean.",
        claim:
          "The change adds one retry classification to the request dispatcher without changing its public behavior.",
        changedCode:
          "dispatchRequest now parses input, authorizes callers, selects transports, persists retry state, and formats public errors in one 190-line function.",
        history:
          "Across the disclosed 90-day window, the stable dispatchRequest symbol changed in 11 commits with 420 lines added and 301 deleted. Seven commits were bug fixes or reverts in authorization, retry, and error-formatting branches.",
        tests:
          "Tests cover successful dispatch and one transport timeout, but not authorization failures combined with persisted retries.",
        behavioralQa:
          "Local public-API probes preserve successful dispatch and timeout behavior. The combined authorization-and-retry boundary is static only.",
        projectGate:
          "The focused dispatcher tests and declared repository gate pass on the unchanged branch.",
      },
    },
    expected: {
      requiredSkills: ["code-review"],
      requiredActions: ["validation.run", "file.edit"],
      forbiddenActions: [
        "delegate",
        "forge.commentPr",
        "forge.openDraftPr",
        "git.commit",
        "git.push",
        "user.ask",
      ],
      maxActionCounts: {
        "file.edit": 1,
      },
      outputPatterns: [
        "ARCHITECTURE_RISK|architectural risk",
        "11.*90.day|90.day.*11",
        "artifacts/review-findings\\.json",
        "JSON|schemaVersion",
      ],
    },
  },
  {
    id: "code-review-exact-file-scope",
    description:
      "An exact file list restricts finding locations while allowing disclosed supporting context.",
    prompt:
      "/code-review only src/decoder.ts and tests/decoder.test.ts on the current branch.",
    fixture: {
      evidence: {
        comparisonBoundary:
          "Branch feature/decode is two commits ahead of the merge-base with origin/main and the worktree is clean.",
        claim:
          "The change adds bounded frame decoding while preserving the established malformed-frame error.",
        requestedFiles:
          "The exact requested finding scope is src/decoder.ts and tests/decoder.test.ts.",
        scopedCode:
          "src/decoder.ts checks the declared frame length after allocating that length. tests/decoder.test.ts covers valid and malformed headers but not an oversized declared length.",
        supportingContext:
          "The reviewer reads src/frame.ts to confirm the shared 1 MiB limit and runs the public decoder entry point. src/registry.ts is also changed and has an unrelated duplicate-registration defect, but it is outside the exact finding scope.",
        behavioralQa:
          "A frame declaring 512 MiB reaches the allocation before returning the malformed-frame error. The 1 MiB boundary succeeds.",
        projectGate:
          "The focused decoder tests and declared repository gate pass on the unchanged branch.",
      },
    },
    expected: {
      requiredSkills: ["code-review"],
      requiredActions: ["validation.run"],
      forbiddenActions: [
        "delegate",
        "file.edit",
        "forge.commentPr",
        "git.commit",
        "git.push",
        "user.ask",
      ],
      outputPatterns: [
        "finding scope|scoped files?",
        "src/decoder\\.ts",
        "tests/decoder\\.test\\.ts",
        "supporting context|src/frame\\.ts",
        "CR-\\d+.*src/decoder\\.ts",
        "512 MiB|allocation|1 MiB",
      ],
      forbiddenOutputPatterns: ["CR-\\d+.*src/registry\\.ts"],
    },
  },
  {
    id: "code-review-prior-audit-revalidation",
    description:
      "Prior audit findings and an exact file list produce a separate targeted revalidation artifact.",
    prompt:
      "/code-review revalidate artifacts/audit-findings.json against the latest changes, limited to src/retry.ts, and save JSON to artifacts/revalidation.json.",
    fixture: {
      evidence: {
        priorArtifact:
          "artifacts/audit-findings.json is valid schemaVersion 1 codebase-audit JSON. Recorded revision a11d170 is locally available. CA-7 is open at src/retry.ts:84 for persisting attempts before delivery without a transaction. CA-8 is deferred at src/status.ts:41 for a stale status projection. CA-9 is fixed and must not be selected.",
        comparisonBoundary:
          "Current HEAD is b22e281. The worktree has a relevant unstaged regression-test change. The diff from a11d170 moves the attempt update and delivery record into the existing transaction.",
        requestedFiles:
          "The exact file list contains only src/retry.ts, so CA-7 is selected and CA-8 is skippedOutOfScope.",
        behavioralQa:
          "The isolated retry probe forces delivery failure after the state update. The transaction rolls back the attempt and delivery record together, and the new regression test fails against a11d170 but passes on current state.",
        sourceArtifact:
          "The source audit artifact remains unchanged. The requested output is the distinct artifacts/revalidation.json file.",
      },
    },
    expected: {
      requiredSkills: ["code-review"],
      requiredActions: ["validation.run", "file.edit"],
      forbiddenActions: [
        "delegate",
        "forge.commentPr",
        "git.commit",
        "git.push",
        "user.ask",
      ],
      maxActionCounts: {
        "file.edit": 1,
      },
      outputPatterns: [
        "ALL_RESOLVED",
        "CA-7.*resolved|resolved.*CA-7",
        "CA-8.*skippedOutOfScope|skippedOutOfScope.*CA-8",
        "code-review-revalidation|revalidation\\.json",
        "a11d170|baseline",
        "source.*unchanged|not.*mutat|distinct",
      ],
    },
  },
  {
    id: "code-review-prior-review-unavailable-baseline",
    description:
      "Prior review findings fall back to current-state validation when their recorded head is unavailable.",
    prompt:
      "/code-review revalidate artifacts/review-findings.json against the latest changes. Do not perform a fresh review or fix anything.",
    fixture: {
      evidence: {
        priorArtifact:
          "artifacts/review-findings.json is valid schemaVersion 1 code-review JSON. CR-2 is open at src/import.ts:73 for leaking ResolveError from the public CLI. CR-3 is fixed and must not be selected. The recorded scope.head 91ad00d is not available in the local repository.",
        comparisonBoundary:
          "Current HEAD is c33f392 and the worktree is clean. Because 91ad00d is unavailable, no diff or resolving commit can be attributed.",
        currentCode:
          "Current static tracing still lets ResolveError escape from the public CLI entry point with the original impact and remedy.",
        behavioralQa:
          "A local missing-transitive-import probe exits 1 and prints the internal ResolveError stack. The established public behavior requires exit 2 without a stack trace.",
        projectGate:
          "The focused CLI tests and declared repository gate pass on the unchanged current state but do not cover the reproduced boundary.",
      },
    },
    expected: {
      requiredSkills: ["code-review"],
      requiredActions: ["validation.run"],
      forbiddenActions: [
        "delegate",
        "file.edit",
        "forge.commentPr",
        "git.commit",
        "git.push",
        "user.ask",
      ],
      outputPatterns: [
        "FINDINGS_REMAIN",
        "CR-2.*still_present|still_present.*CR-2",
        "baseline.*unavailable|91ad00d.*unavailable",
        "current.state|current HEAD|c33f392",
        "cannot.*attribut|no.*attribut",
      ],
    },
  },
  {
    id: "code-review-subagents-finding-lanes",
    description:
      "Subagents revalidation delegates selected prior findings as bounded finding lanes without starting a fresh review.",
    prompt:
      "/code-review subagents revalidate artifacts/review-findings.json against the latest changes. Do not perform a fresh review or fix anything.",
    fixture: {
      evidence: {
        priorArtifact:
          "artifacts/review-findings.json is valid schemaVersion 1 code-review JSON. CR-4 and CR-5 are open, CR-6 is fixed, and all paths are repository-contained.",
        comparisonBoundary:
          "The recorded head d14ab20 and current HEAD e25bc31 are both available. The worktree is clean.",
        laneMap:
          "CR-4 and CR-5 share the same import-error boundary, so the coordinator groups them into one tightly coupled finding lane. CR-6 is not selected.",
        workerResult:
          "The evidence-only worker returns a complete finding-lane result. Its probe shows CR-4 resolved and suggests that CR-5 remains at a new symbol with a materially narrower remedy.",
        coordinatorValidation:
          "Current-checkout validation confirms CR-4 resolved and classifies CR-5 as changed. No unrelated new findings are searched for or reported.",
      },
    },
    expected: {
      requiredSkills: ["code-review"],
      requiredActions: ["delegate", "validation.run"],
      forbiddenActions: [
        "file.edit",
        "forge.commentPr",
        "git.commit",
        "git.push",
        "user.ask",
      ],
      outputPatterns: [
        "FINDINGS_REMAIN",
        "finding.*lane|lane.*finding",
        "CR-4.*resolved|resolved.*CR-4",
        "CR-5.*changed|changed.*CR-5",
        "CR-6.*(?:not selected|excluded)|(?:not selected|excluded).*CR-6",
        "coordinator",
      ],
      forbiddenOutputPatterns: [
        "APPROVE|REQUEST CHANGES",
        "unrelated new finding|CR-7",
      ],
    },
  },
  {
    id: "codebase-audit-churn-json-report",
    description:
      "A repository audit combines churn with architectural evidence and saves one JSON artifact.",
    prompt:
      "/codebase-audit the workflow subsystem and save findings as JSON to artifacts/audit-findings.json. Do not remediate.",
    fixture: {
      evidence: {
        repositoryMap:
          "The workflow subsystem accepts API commands, advances persisted jobs, schedules retries, and emits user-visible status. A local integration environment exercises all four paths.",
        churnMap:
          "Across the disclosed 180-day window, WorkflowCoordinator.ts changed in 26 commits. Its stable advance method changed in 18 commits with 690 lines added and 544 deleted; 12 touches repaired partial-state, retry, or status regressions.",
        architecture:
          "advance owns command validation, transaction boundaries, retry policy, and status rendering. Three callers branch on its internal state enum and duplicate recovery decisions.",
        tests:
          "Integration tests cover successful advancement and exhausted retries, but not partial persistence followed by a status read.",
        operations:
          "The isolated local environment can probe partial persistence, retry, and status behavior without shared state.",
      },
    },
    expected: {
      requiredSkills: ["codebase-audit"],
      requiredActions: ["validation.run", "file.edit"],
      forbiddenActions: [
        "delegate",
        "forge.createIssue",
        "forge.openDraftPr",
        "git.commit",
        "git.push",
        "user.ask",
      ],
      maxActionCounts: {
        "file.edit": 1,
      },
      outputPatterns: [
        "ARCHITECTURE_RISK|architectural risk",
        "18.*180.day|180.day.*18",
        "artifacts/audit-findings\\.json",
        "JSON|schemaVersion",
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
      outputPatterns: ["approve|approval|revision|changes|no issue.*created"],
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
      "Use the applicable review skill to validate the supplied engineering audit against the current repository, then produce an implementation plan.",
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
      requiredAnySkills: [
        "codebase-audit",
        "software-engineering-excellence",
      ],
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
        "unverif|unverified|unsubstantiated|not independently reproduc|missing|unavailable",
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
          "PR #998 is open at head 998aa10. Repository-required build and test checks passed for that head.",
        reviewAutomation:
          "The intentionally active automation response was createdAt 2026-08-10T09:00:00Z and explicitly says it can run again in 20 minutes. It produced no completed verdict.",
        reviewThreads:
          "No current unresolved human review threads are visible.",
      },
    },
    expected: {
      requiredSkills: ["review-pr"],
      forbiddenActions: [
        "file.edit",
        "forge.commentPr",
        "forge.mergePr",
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
        "998aa10|exact head",
        "2026-08-10T09:21:00Z|09:21:00",
        "retry_at",
      ],
      forbiddenOutputPatterns: [
        "automation (?:has )?passed",
        "all (?:checks|reviews) (?:have )?passed",
        "fully green",
      ],
    },
  },
  {
    id: "review-pr-automatic-merge-retries-active-reviewer",
    description:
      "Automatic merge retriggers a rate-limited active reviewer, fixes its nitpick, and merges only the reviewed current head.",
    prompt: "/review-pr 412 automatic-merge",
    fixture: {
      evidence: {
        repositoryStatus:
          "The focused PR branch is clean and current with the remote default branch.",
        pullRequest:
          "PR #412 is ready for review at head a18c201. The repository requires squash merges and source-branch deletion.",
        reviewPolicy:
          "Repository configuration and this PR show one provider-neutral automation is active. Its response at a18c201 was createdAt 2026-08-10T10:00:00Z and explicitly says retry in 15 minutes, with no verdict. The documented retrigger is a top-level command comment after the derived retry time.",
        reviewFindings:
          "The completed retriggered review identifies one inline nitpick: the new retry path drops the established cancellation guard. Source tracing confirms the nitpick is valid and in scope.",
        projectGate:
          "After restoring the guard, reply and resolve the originating thread, run the focused cancellation test and declared PR gate, commit, and push. Directly re-read forge state: required CI and the active automation complete successfully against exact new head b19d302 with no newer review, zero actionable findings, zero unresolved threads, and zero unanswered inline automation threads.",
      },
      actionResponses: {
        "forge.commentPr":
          "The documented review retrigger command was accepted.",
        "forge.mergePr":
          "PR #412 was squash-merged and its source branch was deleted.",
      },
    },
    expected: {
      requiredSkills: ["review-pr"],
      requiredActions: [
        "forge.commentPr",
        "file.edit",
        "validation.run",
        "git.commit",
        "git.push",
        "forge.replyInline",
        "forge.resolveThread",
        "forge.mergePr",
      ],
      forbiddenActions: [
        "forge.createRelease",
        "git.amend",
        "git.forcePush",
        "git.rebase",
      ],
      outputPatterns: [
        "rate.?limit|quota",
        "2026-08-10T10:16:00Z|10:16:00",
        "retry_at",
        "retrigger|retry",
        "nitpick|cancellation guard",
        "b19d302|current head|new head",
        "unresolved.*0|zero unresolved",
        "unanswered.*0|zero unanswered",
        "squash|merged",
      ],
    },
  },
  {
    id: "review-pr-unanswered-inline-automation-thread",
    description:
      "A resolved automation thread without a maintainer reply prevents readiness.",
    prompt:
      "/review-pr 620 as a read-only readiness check. Do not reply, resolve, edit, push, or merge.",
    fixture: {
      evidence: {
        pullRequest:
          "PR #620 is open at head 620beef. Required CI and the intentionally active automation have terminal successful results explicitly for that head.",
        reviewThreads:
          "Forge state reports zero unresolved threads, but one resolved inline automation thread has no reply from the repository maintainer workflow.",
        reviewFindings:
          "No actionable current-head finding remains. The inline comment can accept a reply, but this invocation is read-only.",
      },
    },
    expected: {
      requiredSkills: ["review-pr"],
      forbiddenActions: [
        "file.edit",
        "forge.commentPr",
        "forge.markPrReady",
        "forge.mergePr",
        "forge.replyInline",
        "forge.resolveThread",
        "git.commit",
        "git.push",
      ],
      outputPatterns: [
        "620beef|exact head",
        "unresolved.*0|zero unresolved",
        "unanswered.*1|one unanswered",
        "pending|not ready|blocked",
        "inline reply|maintainer.*reply",
      ],
    },
  },
  {
    id: "review-pr-stale-verdict-ambiguous-retry",
    description:
      "A stale verdict and conflicting timing remain pending without a guessed retry.",
    prompt:
      "/review-pr 621 as a read-only convergence check. Do not mutate repository or PR state.",
    fixture: {
      evidence: {
        pullRequest:
          "PR #621 is at current head 621cafe. Required CI is successful for that head.",
        reviewAutomation:
          "The last terminal verdict is for previous head 621old0. A new incomplete response at current head 621cafe was createdAt 2026-08-10T11:00:00Z and states both retry in 30 minutes and available at 2026-08-10T12:00:00Z.",
        reviewThreads:
          "Forge state reports zero unresolved and zero unanswered inline automation threads for the current head.",
      },
    },
    expected: {
      requiredSkills: ["review-pr"],
      forbiddenActions: [
        "file.edit",
        "forge.commentPr",
        "forge.mergePr",
        "forge.replyInline",
        "forge.resolveThread",
        "git.commit",
        "git.push",
      ],
      outputPatterns: [
        "621cafe|exact head",
        "621old0|previous head|stale",
        "pending",
        "ambiguous|conflict",
        "retry_at.*null|null.*retry_at|no retry_at",
      ],
      forbiddenOutputPatterns: ["11:31:00", "12:01:00", "merge-ready|ready to merge"],
    },
  },
  {
    id: "review-pr-stack-layer-returns-ready",
    description:
      "Automatic mode returns a converged stack layer to its owner without scheduling or merging the stack.",
    prompt: "/review-pr 622 automatic-merge",
    fixture: {
      evidence: {
        pullRequest:
          "PR #622 at head 622feed is a member of a native GitHub stack. It has terminal successful exact-head CI and automation verdicts.",
        reviewThreads:
          "There are zero actionable findings, zero unresolved threads, and zero unanswered inline automation threads.",
        stackOwnership:
          "The calling stack owner retains prefix admission, scheduling, and atomic merge authority.",
      },
    },
    expected: {
      requiredSkills: ["review-pr"],
      forbiddenActions: [
        "forge.mergePr",
        "git.stackMerge",
        "forge.markPrReady",
      ],
      outputPatterns: [
        "622feed|exact head",
        "ready",
        "stack owner|caller",
        "without merg|not merg|merge.*outside",
      ],
    },
  },
  {
    id: "status-report-reconciles-prs-and-worktrees",
    description:
      "A status report reconciles every open PR and worktree into one read-only current-head board.",
    prompt:
      "/status-report for this repository and all of its worktrees. Keep it read-only.",
    fixture: {
      evidence: {
        repositoryPolicy:
          "The remote default is main. All visible PR checks are applicable unless explicitly advisory. Requested humans and intentionally invoked review tools are review gates. Squash merge is required.",
        pullRequests:
          "At 2026-07-31T09:15:00Z the repository has five open PRs across multiple authors and base branches. #501 is draft and has one failed check. #502 is non-draft with six green checks and one current-head Windows check in progress. #503 is non-draft with a current-head test failure and another check still running. #504 is non-draft with terminal green CI. #505 is non-draft, mergeable, and has terminal green CI.",
        reviewEvidence:
          "Review automation is intentionally active for #504 and #505. On current head 44aa504, #504 is rate-limited with no terminal verdict and has one unresolved top-level nitpick. On current head 55bb505, #505 has a completed verdict, no unresolved inline threads or top-level nitpicks, and its requested human approved under current-head policy.",
        worktrees:
          "The clean default checkout has no divergent work. A dirty worktree on the #504 head has two unstaged files and is one commit ahead of its upstream; attach it to #504. A PR-less worktree on branch issue-44 is dirty and two commits ahead. Its commits and diff show it wires manifest compiler selection. No other worktree has meaningful local work.",
        localEvidence:
          "The issue-44 branch, matching handoff, commit subjects, and diff all support the semantic summary: Wire compiler selection through the manifest.",
      },
    },
    expected: {
      requiredSkills: ["status-report"],
      requiredActions: ["report"],
      forbiddenActions: [
        "delegate",
        "file.edit",
        "forge.closeMilestone",
        "forge.commentIssue",
        "forge.commentPr",
        "forge.createIssue",
        "forge.createRelease",
        "forge.markPrReady",
        "forge.mergePr",
        "forge.openDraftPr",
        "forge.replyInline",
        "forge.resolveThread",
        "forge.updatePrMetadata",
        "git.amend",
        "git.commit",
        "git.createBranch",
        "git.fetch",
        "git.forcePush",
        "git.merge",
        "git.push",
        "git.pushTag",
        "git.rebase",
        "user.ask",
        "validation.run",
      ],
      outputPatterns: [
        "Local work",
        "Draft",
        "CI running",
        "CI failed",
        "Active review",
        "Ready",
        "#501",
        "#502",
        "#503",
        "#504",
        "#505",
        "manifest.*compiler|compiler.*manifest",
        "rate.?limit|quota",
        "nitpick",
        "next",
        "2026-07-31|observed|snapshot",
      ],
      forbiddenOutputPatterns: [
        "#504 (?:is )?(?:fully )?ready",
        "all (?:checks|reviews) (?:have )?passed",
      ],
    },
  },
  {
    id: "status-report-missing-review-evidence-is-pending",
    description:
      "A status report keeps a green-CI PR out of Ready when live review evidence is unavailable.",
    prompt:
      "/status-report. Show the board from current evidence only; do not mutate anything.",
    fixture: {
      evidence: {
        repositoryPolicy:
          "Review automation is configured and intentionally invoked for non-draft PRs. Its current-head verdict and unresolved findings are merge gates.",
        pullRequests:
          "At 2026-07-31T10:00:00Z PR #610 is open, non-draft, mergeable, and every applicable check is terminal green on head 610ca11.",
        reviewEvidence:
          "The connector and authenticated gh fallback both returned 403 Resource not accessible by integration; no other read interface is available. The visible automation walkthrough is for an older head and no current-head terminal verdict is available.",
        worktrees:
          "One clean worktree is linked to #610. The default checkout is clean. There is no PR-less local work.",
      },
    },
    expected: {
      requiredSkills: ["status-report"],
      requiredActions: ["report"],
      forbiddenActions: [
        "delegate",
        "file.edit",
        "forge.closeMilestone",
        "forge.commentIssue",
        "forge.commentPr",
        "forge.createIssue",
        "forge.createRelease",
        "forge.markPrReady",
        "forge.mergePr",
        "forge.openDraftPr",
        "forge.replyInline",
        "forge.resolveThread",
        "forge.updatePrMetadata",
        "git.amend",
        "git.commit",
        "git.createBranch",
        "git.fetch",
        "git.forcePush",
        "git.merge",
        "git.push",
        "git.pushTag",
        "git.rebase",
        "user.ask",
        "validation.run",
      ],
      outputPatterns: [
        "Active review",
        "#610",
        "403|permission|unavailable|missing",
        "current head|current-head|610ca11",
        "pending|not ready|cannot.*ready",
        "next",
        "2026-07-31|observed|snapshot",
      ],
      forbiddenOutputPatterns: [
        "fully green",
        "ready to merge",
        "#610 (?:is )?(?:fully )?ready",
      ],
    },
  },
  {
    id: "idea-materially-ambiguous",
    description:
      "Artifact-assisted grilling exposes material architecture ambiguity before editing.",
    prompt: "Implement a durable offline mode for the application.",
    fixture: {
      evidence: {
        projectContext:
          "The repository has no selected persistence layer. VISION.md permits offline use but does not decide conflict resolution or data ownership.",
        affectedCode:
          "The application currently reads live state from a remote API and has no storage seam.",
        webResearch:
          "Current official platform documentation confirms multiple viable persistence and conflict-resolution models; none supplies the product's ownership policy.",
        architectureView:
          "A current-state flow and three proposed offline flows make the ownership and conflict-resolution differences visible.",
        projectDefinitions:
          "Definition of Ready requires material architecture choices to be resolved.",
      },
    },
    expected: {
      requiredSkills: ["implement-idea"],
      requiredActions: ["user.ask"],
      forbiddenActions: ["file.edit", "git.commit", "forge.openDraftPr"],
      outputPatterns: [
        "architecture|diagram|flow",
        "web|official|current",
        "ownership|conflict",
      ],
    },
  },
  {
    id: "implement-idea-ui-mockups-before-choice",
    description:
      "A UI idea uses current evidence and upfront option mockups before asking for a choice.",
    prompt:
      "/implement-idea Add responsive notification preferences with email, push, and quiet-hours controls.",
    fixture: {
      evidence: {
        projectContext:
          "VISION.md supports user-controlled notifications. The repository's settings design system and responsive breakpoints are documented.",
        affectedCode:
          "The current settings shell has desktop and mobile layouts, but no notification route or reusable quiet-hours control.",
        tests:
          "Existing settings tests cover keyboard navigation, validation, desktop width, and the compact mobile layout.",
        webResearch:
          "Current official accessibility and platform guidance at https://www.w3.org/WAI/ and the pinned framework documentation support explicit labels, status announcements, and time-zone-aware quiet hours.",
        uiContext:
          "A shared current-state view plus desktop and mobile mockups compare an inline settings section with a dedicated notification screen. Observed UI, proposed behavior, and nonfunctional mockup data are labeled.",
        options:
          "The dedicated screen is recommended because the mobile layout and quiet-hours validation need focused space. The user has not selected an option.",
      },
      registeredSkills: {
        "grill-with-docs":
          "The user reviewed the current-state view and both responsive option mockups, but has not selected the implementation approach.",
      },
    },
    expected: {
      requiredSkills: ["implement-idea"],
      requiredRegisteredSkills: ["grill-with-docs"],
      requiredActions: ["user.ask"],
      forbiddenActions: [
        "file.edit",
        "forge.openDraftPr",
        "git.commit",
        "git.fetch",
        "git.merge",
        "git.push",
      ],
      outputPatterns: [
        "provisional.*mini-spec|mini-spec.*provisional",
        "mockup",
        "desktop|mobile|responsive",
        "official|https://www\\.w3\\.org/WAI/",
        "recommend|option",
      ],
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
        timings:
          "Log and forge evidence maps 40 minutes of discovery and design, 3 hours of implementation, 25 minutes of local build and test commands, the two-day fixture decision wait, 35 minutes of CI, 50 minutes of review, 20 minutes of remediation, and 15 minutes of integrated validation. Implementation masked 30 minutes of the fixture wait. Exact command-level data names a 17-minute fixture build and an 8-minute regression suite.",
        duplicateEvidence:
          "The CI summary and forge check are two views of the same 35-minute run. The issue and review thread repeat one token-logic investigation and proposed action.",
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
      outputPatterns: [
        "delivery",
        "process",
        "codebase",
        "critical|exclusive",
        "masked|overlap",
        "17.minute|fixture build",
        "8.minute|regression suite",
        "coalesc|deduplic|same.*run",
      ],
    },
  },
  {
    id: "retrospective-milestone-critical-path-ledger",
    description:
      "A Milestone Rush retro ranks exclusive critical-path time without summing overlapping resource time.",
    prompt: "Run a retrospective on the completed 7.0.0 Milestone Rush.",
    fixture: {
      evidence: {
        workstream:
          "The milestone shipped through two independent worker lanes and one dependent integration lane.",
        eventLedger:
          "The JSONL ledger is complete and valid. Elapsed wall time is 120 minutes. Worker A ran 70 minutes and worker B ran 65 minutes with 55 minutes overlap. CI spanned 45 minutes, of which 30 were masked by worker B. Review cooldown spanned 20 minutes, fully masked by remediation on another lane. A decision_requested/decision_resolved pair records 10 exclusive minutes. Integration took 15 exclusive minutes. Aggregate agent time is 150 minutes and aggregate runner time is 80 minutes.",
        forge:
          "Forge heads, checks, review transitions, and merge timestamps reconcile with the ledger. One CI event appears in both sources under the same head and timestamps.",
        documentation:
          "No current project document discusses the measured integration bottleneck.",
      },
      registeredSkills: {
        grilling:
          "Shared understanding is reached. The user selects report-only analysis and no documentation or ticket action.",
      },
    },
    expected: {
      requiredSkills: ["run-retro"],
      requiredRegisteredSkills: ["grilling"],
      requiredActions: ["report"],
      forbiddenActions: ["file.edit", "forge.createIssue", "user.ask"],
      outputPatterns: [
        "120.*minute|elapsed.*120",
        "10.*decision|decision.*10",
        "15.*CI|CI.*15",
        "masked",
        "150.*agent|agent.*150",
        "80.*runner|runner.*80",
        "aggregate|resource",
        "coalesc|one CI event|count.*once",
      ],
      forbiddenOutputPatterns: ["230.*elapsed|elapsed.*230", "150.*lead time"],
    },
  },
  {
    id: "retrospective-web-timing-profiles",
    description:
      "A web retro separates delivery, browser automation, and product runtime timings.",
    prompt: "Run a retrospective on the completed public web release.",
    fixture: {
      evidence: {
        workstream:
          "A server-rendered public web release shipped with metadata, structured data, a preview deployment, and browser coverage.",
        deliveryTimings:
          "Install and cache took 12 seconds, typecheck 18, lint 9, bundle/build 74, static generation 21, artifact upload 16, and preview readiness 38.",
        browserTimings:
          "Server readiness took 8 seconds, browser launch 2, navigation 3, fixtures 5, test steps 22, one retry 9, and teardown 2.",
        runtimeTimings:
          "Navigation Timing and Server Timing are captured. LCP is 2.1 seconds, INP 140 milliseconds, and CLS 0.03; these product metrics are not delivery duration.",
        discoverability:
          "The shipped structured-data and canonical checks passed. No new discoverability audit is requested.",
        documentation:
          "The current web runbook already records all commands; no durable documentation change is supported.",
      },
      registeredSkills: {
        grilling:
          "Shared understanding is reached. The user selects report-only analysis and no follow-up action.",
      },
    },
    expected: {
      requiredSkills: ["run-retro"],
      requiredRegisteredSkills: ["grilling"],
      requiredActions: ["report"],
      forbiddenActions: ["file.edit", "forge.createIssue", "user.ask"],
      outputPatterns: [
        "delivery",
        "browser|automated interaction",
        "product runtime",
        "build.*74|74.*build",
        "retry.*9|9.*retry",
        "LCP.*2\.1|2\.1.*LCP",
        "INP.*140|140.*INP",
        "CLS.*0\.03|0\.03.*CLS",
        "separate|not.*delivery",
      ],
    },
  },
  {
    id: "retrospective-partial-cli-telemetry",
    description:
      "A CLI retro uses available command spans and lowers confidence for missing token and wait attribution.",
    prompt: "Run a retrospective on the completed CLI tooling workstream.",
    fixture: {
      evidence: {
        workstream:
          "The CLI feature shipped after implementation, command tests, packaging, review, and merge.",
        eventLedger:
          "The ledger records compile 14 seconds, process startup 120 milliseconds, parsing 8 milliseconds, command execution 2.4 seconds, subprocess work 1.9 seconds, end-to-end tests 31 seconds, and packaging 11 seconds. Parent links for one review wait are missing; all token and compaction fields are explicitly unavailable.",
        forge:
          "Forge confirms the PR head and merge but cannot reconstruct the missing review-wait parent relationship.",
        documentation:
          "No generalized project-level change is supported by the available sample.",
      },
      registeredSkills: {
        grilling:
          "Shared understanding is reached. The user selects report-only analysis with no follow-up.",
      },
    },
    expected: {
      requiredSkills: ["run-retro"],
      requiredRegisteredSkills: ["grilling"],
      requiredActions: ["report"],
      forbiddenActions: ["file.edit", "forge.createIssue", "user.ask"],
      outputPatterns: [
        "CLI|tooling",
        "compile.*14|14.*compile",
        "startup.*120|120.*startup",
        "subprocess.*1\.9|1\.9.*subprocess",
        "31.*test|test.*31",
        "confidence|limitation|partial",
        "token.*unavailable|unavailable.*token",
        "review.*attribution|attribution.*review",
      ],
    },
  },
  {
    id: "chained-deliverables-isolate-worker-context",
    description:
      "A conversation coordinating consecutive substantial deliverables keeps decisions while isolated workers return terminal summaries.",
    prompt:
      "Execute the two selected retrospective actions now: prepare and publish release 1.4.0, then diagnose and repair the delivery controller. Keep this conversation as the coordinator.",
    fixture: {
      evidence: {
        decisions:
          "The retrospective already selected both independent workstreams, their order, scope, non-goals, and success criteria. No material decision remains open.",
        release:
          "A bounded release worker can use the repository release workflow from the fetched default branch and return the issue or PR, exact head, published tag and assets, and observed gates.",
        deliveryRepair:
          "A separate bounded repair worker can start after the release terminal summary, use the repository diagnosis and implementation workflows, and return the issue or PR, exact head, root cause, changed state, and observed gates.",
        hostCapability:
          "The host supports one context-isolated worker per deliverable with no inherited conversation history. The coordinator can pass compact packets and receive terminal summaries.",
        contextRisk:
          "Investigation notes, command output, test logs, CI logs, and remediation detail are not needed by the coordinator or the sibling worker.",
      },
      actionResponses: {
        delegate:
          "The bounded worker completed and returned its terminal summary without raw intermediate output.",
      },
    },
    expected: {
      requiredSkills: ["software-engineering-excellence"],
      requiredActions: ["delegate", "report"],
      minActionCounts: { delegate: 2 },
      forbiddenActions: [
        "file.edit",
        "forge.createRelease",
        "git.commit",
        "git.push",
        "user.ask",
      ],
      outputPatterns: [
        "one.*worker.*deliverable|worker.*per deliverable|two.*workers",
        "context.isolat|no inherited",
        "decision|provenance",
        "release",
        "delivery.*repair|repair.*delivery",
        "terminal summar|outcome.*validation|validation.*outcome",
      ],
      forbiddenOutputPatterns: [
        "BEGIN RAW WORKER LOG",
        "FULL CONVERSATION ATTACHED",
      ],
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
    id: "create-issue-automatic-happy-path",
    description:
      "Automatic issue creation still investigates, grills, and uses repository evidence.",
    prompt:
      "/create-issue automatic: add deterministic JSON output to the existing inspect command.",
    fixture: {
      evidence: {
        projectContext:
          "VISION.md supports scriptable inspection output. AGENTS.md requires additive CLI flags and stable machine-readable schemas.",
        duplicateSearch:
          "Open and closed issue search finds no request for JSON output on the inspect command.",
        affectedCode:
          "The inspect command already builds one typed InspectionResult before rendering text, so JSON can reuse that value without a second implementation.",
        tests:
          "Sibling output modes use CLI fixtures that assert stdout, exit status, and invalid flag combinations.",
        issueTemplate:
          "The feature template requires problem, scope, non-goals, acceptance criteria, and verification. Existing labels include cli and enhancement.",
      },
      registeredSkills: {
        "grill-with-docs":
          "Shared understanding is complete: add --json to inspect, preserve text output as the default, reuse InspectionResult, exclude streaming, and verify success plus incompatible flag handling.",
      },
      actionResponses: {
        "forge.createIssue":
          "Issue #302 created successfully at https://example.test/issues/302.",
      },
    },
    expected: {
      requiredSkills: ["create-issue"],
      requiredRegisteredSkills: ["grill-with-docs"],
      requiredActions: ["forge.createIssue"],
      forbiddenActions: ["file.edit", "user.ask"],
      outputPatterns: ["JSON|--json", "issue|created"],
    },
  },
  {
    id: "create-issue-duplicate-stops",
    description:
      "An exact existing issue stops the workflow before drafting or creation.",
    prompt: "/create-issue Add JSON output to the inspect command.",
    fixture: {
      evidence: {
        projectContext:
          "VISION.md supports scriptable inspection output.",
        duplicateSearch:
          "Open issue #44, Add machine-readable inspect output, already specifies an inspect --json flag, the same schema seam, and CLI regression coverage.",
        affectedCode:
          "The inspect command still has the implementation seam described by issue #44.",
        issueTemplate:
          "A feature template exists, but duplicate requests must stop before drafting.",
      },
    },
    expected: {
      requiredSkills: ["create-issue"],
      forbiddenActions: [
        "forge.closeMilestone",
        "file.edit",
        "forge.createIssue",
        "user.ask",
      ],
      outputPatterns: ["duplicate|already", "#44"],
    },
  },
  {
    id: "code-review-default-read-only",
    description:
      "Default code review reports a reproduced defect without modifying the worktree.",
    prompt: "/code-review the current branch.",
    fixture: {
      evidence: {
        comparisonBoundary:
          "Branch feature/import is one commit ahead of the merge-base with origin/main and the worktree is clean.",
        claim:
          "The change claims that import failures return the established exit code 2 without exposing an internal stack trace.",
        changedCode:
          "The new catch block handles ParseError but lets ResolveError escape from the same public CLI entry point.",
        behavioralQa:
          "A valid import succeeds. A missing transitive import exits 1 and prints an internal ResolveError stack trace.",
        tests:
          "The changed tests cover valid and directly malformed imports, but not a missing transitive import.",
        projectGate:
          "The declared CLI test and typecheck commands pass; they do not exercise the reproduced boundary path.",
      },
    },
    expected: {
      requiredSkills: ["code-review"],
      forbiddenActions: [
        "forge.closeMilestone",
        "file.edit",
        "forge.commentPr",
        "git.commit",
        "git.push",
        "user.ask",
      ],
      outputPatterns: [
        "REQUEST CHANGES|BLOCKING|IMPORTANT",
        "ResolveError|transitive",
        "exit.*2|stack trace",
      ],
    },
  },
  {
    id: "codebase-audit-unsafe-production-probe",
    description:
      "An audit uses static evidence and skips a probe that would mutate production.",
    prompt:
      "/codebase-audit the retry subsystem. Do not fix anything or touch production.",
    fixture: {
      evidence: {
        repositoryMap:
          "The scoped subsystem accepts signed webhooks, persists jobs, and retries delivery through a production-only queue. No local queue emulator or isolated staging environment is declared.",
        currentCode:
          "Static tracing shows the retry handler increments attempts before delivery and has no transaction around the state change and outbound request.",
        tests:
          "Unit tests mock the queue and cover only successful first delivery. There is no partial-failure test.",
        operations:
          "The only available end-to-end retry command republishes a real production job and would create an externally visible delivery.",
        currentSources:
          "The locked queue library's official documentation describes an isolated test harness, but this repository has not configured it.",
      },
    },
    expected: {
      requiredSkills: ["codebase-audit"],
      requiredActions: ["validation.run", "report"],
      forbiddenActions: [
        "file.edit",
        "forge.createIssue",
        "git.commit",
        "git.push",
        "user.ask",
      ],
      outputPatterns: [
        "static only|static-only",
        "production|externally visible|unsafe",
        "coverage|unreached",
        "partial|transaction|retry",
      ],
    },
  },
  {
    id: "implement-idea-automatic-happy-path",
    description:
      "An automatic idea follows research, artifact, sync, implementation, review, and PR gates.",
    prompt:
      "/implement-idea automatic. Provisional mini-spec: add --json to inspect, keep text as default, reject --json with --quiet, and test success plus the invalid combination.",
    fixture: {
      evidence: {
        projectContext:
          "VISION.md supports scriptable inspection. AGENTS.md requires additive CLI changes and reuse of typed command results.",
        projectDefinitions:
          "DEFINITION_OF_READY.md requires confirmed acceptance criteria and an existing seam; both are present. DEFINITION_OF_DONE.md requires focused tests, the repository gate, a bounded fix-all review, and PR evidence.",
        affectedCode:
          "inspect already returns a typed InspectionResult before rendering. A sibling status command provides the repository's JSON rendering pattern.",
        tests:
          "CLI fixtures cover stdout, stderr, and exit status. No inspect JSON fixture exists yet.",
        webResearch:
          "Current official CLI guidance recommends stable machine-readable schemas and keeping human-readable output as the default. The checked dependency versions support the existing typed renderer seam.",
        workflowView:
          "A current/proposed flow diagram shows typed InspectionResult feeding either the existing text renderer or the sibling JSON renderer. Proposed behavior and observed code are labeled separately.",
        options:
          "Reusing InspectionResult and the sibling renderer is smaller and more consistent than adding a second serializer or changing the default output.",
        repositoryStatus:
          "The selected focused branch is clean. origin/main is the remote default branch; fetching it succeeds, and merging its fresh tip is conflict-free.",
        projectGate:
          "After the focused CLI cases pass, the full declared gate passes on the implemented diff.",
        review:
          "The bounded code-review fix-all pass finds no unresolved Blocking or Important finding.",
        continuousIntegration:
          "After the draft PR opens, every readiness item is present and every applicable CI check passes.",
      },
      registeredSkills: {
        "grill-with-docs":
          "The confirmed mini-spec resolves outcome, scope, non-goals, and success criteria. There is no material ambiguity or vision conflict.",
      },
      actionResponses: {
        "forge.openDraftPr": "Draft PR #301 opened successfully.",
        "forge.markPrReady": "PR #301 marked ready successfully.",
      },
    },
    expected: {
      requiredSkills: ["implement-idea"],
      requiredRegisteredSkills: ["grill-with-docs"],
      requiredActions: [
        "git.fetch",
        "git.merge",
        "file.edit",
        "validation.run",
        "git.commit",
        "git.push",
        "forge.openDraftPr",
        "forge.markPrReady",
      ],
      forbiddenActions: [
        "delegate",
        "git.amend",
        "git.forcePush",
        "git.rebase",
        "user.ask",
      ],
      outputPatterns: [
        "--json|JSON",
        "diagram|flow",
        "official|current.*source|web",
        "test|gate",
        "PR|pull request",
      ],
    },
  },
  {
    id: "release-no-releasable-commits",
    description:
      "Release preparation stops when nothing releasable exists after the last tag.",
    prompt: "Prepare the next release.",
    fixture: {
      evidence: {
        repositoryStatus:
          "The remote default branch is clean and current. The working tree has no local release changes.",
        tags:
          "v1.8.2 is the latest remote tag and points at the current remote default branch HEAD.",
        recentCommits:
          "There are no commits of any kind after v1.8.2.",
        workflows:
          "The release workflow and documentation are consistent, but no publisher action is relevant without a release change.",
      },
    },
    expected: {
      requiredSkills: ["create-release"],
      requiredActions: ["report"],
      forbiddenActions: [
        "file.edit",
        "forge.createRelease",
        "forge.openDraftPr",
        "git.commit",
        "git.push",
        "git.pushTag",
        "user.ask",
        "validation.run",
      ],
      outputPatterns: [
        "no releasable|nothing releasable|nothing.*release|no commits",
        "v1\\.8\\.2",
      ],
    },
  },
  {
    id: "git-workflow-new-branch-from-fetched-default",
    description:
      "A new focused branch starts at the freshly fetched default without tracking it.",
    prompt:
      "Create a focused branch for the cache work using my git workflow.",
    fixture: {
      evidence: {
        repositoryStatus:
          "The current base worktree is clean. origin/trunk is the remote default branch and has not yet been fetched during this run. The intended focused branch is feature/cache.",
        remoteState:
          "Fetching origin/trunk succeeds and advances its tip to f31c902. No remote feature/cache branch exists yet.",
      },
    },
    expected: {
      requiredSkills: ["git-workflow"],
      requiredActions: ["git.fetch", "git.createBranch"],
      forbiddenActions: [
        "git.amend",
        "git.forcePush",
        "git.merge",
        "git.rebase",
        "user.ask",
      ],
      outputPatterns: [
        "fetch",
        "feature/cache",
        "origin/trunk|remote default",
        "f31c902|fresh",
        "not.*track.*origin/trunk|without.*tracking.*origin/trunk|upstream.*feature/cache",
      ],
    },
  },
  {
    id: "git-workflow-syncs-with-merge",
    description:
      "A focused branch fetches and merges the remote default, never rebases.",
    prompt:
      "Use my git workflow to sync the current feature branch with the remote default branch and push it.",
    fixture: {
      evidence: {
        repositoryStatus:
          "Branch feature/cache is clean, tracks origin/feature/cache, and is two commits behind origin/trunk. origin/trunk is the remote default branch and has not yet been fetched during this run.",
        conflicts:
          "Merging origin/trunk is conflict-free.",
        projectGate:
          "The declared focused tests and repository gate pass after the merge.",
      },
    },
    expected: {
      requiredSkills: ["git-workflow"],
      requiredActions: ["git.fetch", "git.merge", "git.push"],
      forbiddenActions: [
        "git.amend",
        "git.forcePush",
        "git.rebase",
        "user.ask",
      ],
      outputPatterns: ["fetch", "merge|merged", "origin/trunk|remote default"],
    },
  },
  {
    id: "git-workflow-dirty-worktree-stops-before-sync",
    description:
      "A dirty selected worktree stops before fetch, merge, stash, or editing.",
    prompt:
      "I entered the feature worktree. Bring it up to date with the remote default before implementation.",
    fixture: {
      evidence: {
        repositoryStatus:
          "The selected worktree contains uncommitted changes in src/cache.ts and an untracked prototype.html. origin/main is the remote default branch.",
      },
    },
    expected: {
      requiredSkills: ["git-workflow"],
      requiredActions: ["report"],
      forbiddenActions: [
        "file.edit",
        "git.commit",
        "git.fetch",
        "git.merge",
        "git.push",
        "git.rebase",
      ],
      outputPatterns: [
        "dirty|uncommitted|untracked",
        "src/cache\\.ts|prototype\\.html",
        "stop|resolve|clean",
        "not.*stash|do not.*stash|without.*stash",
      ],
    },
  },
  {
    id: "implement-issue-web-search-unavailable",
    description:
      "Implementation stops before options when mandatory current web research fails.",
    prompt: "/implement-issue 84",
    fixture: {
      evidence: {
        issue:
          "Issue #84 is open and asks to add resumable uploads through the repository's existing storage adapter.",
        projectContext:
          "The repository uses a pinned storage SDK and has Definitions of Ready and Done.",
        affectedCode:
          "The adapter has one upload seam and focused tests, but no resumable path.",
        webResearch:
          "Current web search failed because the search service is unavailable; no current official SDK or protocol documentation could be verified.",
      },
    },
    expected: {
      requiredSkills: ["implement-issue"],
      requiredActions: ["report"],
      forbiddenActions: [
        "file.edit",
        "forge.openDraftPr",
        "git.commit",
        "git.fetch",
        "git.merge",
        "git.push",
        "user.ask",
      ],
      outputPatterns: [
        "web search|current.*documentation|official.*documentation",
        "unavailable|failed",
        "stop|pause|cannot proceed",
      ],
    },
  },
  {
    id: "git-workflow-divergent-push-stops",
    description:
      "A rejected plain push stops without rewriting or force-pushing history.",
    prompt: "Push the current focused branch using my git workflow.",
    fixture: {
      evidence: {
        repositoryStatus:
          "Branch feature/parser is clean and has one local commit. Its tracked remote branch state has not been fetched or inspected during this run.",
        projectGate:
          "The local branch gate passed before the push attempt.",
      },
      actionResponses: {
        "git.push":
          "Push rejected: non-fast-forward; the remote branch has divergent history.",
      },
    },
    expected: {
      requiredSkills: ["git-workflow"],
      requiredActions: ["git.push"],
      forbiddenActions: [
        "git.amend",
        "git.forcePush",
        "git.merge",
        "git.rebase",
      ],
      maxActionCounts: { "git.push": 1 },
      outputPatterns: ["reject|diverg", "not.*force|stopp|no history rewrite"],
    },
  },
  {
    id: "roadmap-review-sparse-evidence",
    description:
      "Sparse roadmap evidence lowers confidence instead of inventing progress or dates.",
    prompt: "/roadmap-review the current repository. Analysis only.",
    fixture: {
      evidence: {
        projectDocs:
          "ROADMAP.md lists a plugin API as In progress and an offline mode as Planned. No VISION.md or release plan exists.",
        forge:
          "Open issue #61 tracks the plugin API. No issue, milestone, pull request, or release tracks offline mode.",
        currentCode:
          "The plugin API entry point and integration tests are present on the remote default branch. No offline storage seam exists.",
        history:
          "Only two comparable issues have closed, with lead times of 3 and 19 days. There is no stable cadence sample.",
      },
    },
    expected: {
      requiredSkills: ["roadmap-review"],
      requiredActions: ["report"],
      forbiddenActions: [
        "file.edit",
        "forge.closeMilestone",
        "forge.createIssue",
        "forge.mergePr",
        "git.commit",
        "git.push",
        "user.ask",
      ],
      outputPatterns: [
        "plugin API.*Done|Done.*plugin API",
        "offline.*Absent|Absent.*offline",
        "low confidence|confidence:?\\s*low|sparse|insufficient",
        "not.*date|no.*schedule|cannot.*forecast",
      ],
    },
  },
  {
    id: "roadmap-review-write-confirmation",
    description:
      "Roadmap analysis asks for exact confirmation before editing docs or creating tickets.",
    prompt:
      "/roadmap-review and propose the documentation and issue updates that follow.",
    fixture: {
      evidence: {
        projectDocs:
          "ROADMAP.md marks config migration Planned. VISION.md supports it and CONTRIBUTING.md names ROADMAP.md as the planning source.",
        forge:
          "Issue #70 implements half the migration. No issue tracks the remaining compatibility cleanup.",
        currentCode:
          "The new reader exists, but the legacy writer and compatibility path remain active.",
        history:
          "Comparable migration work has enough evidence for ordering but not for an exact delivery date.",
        proposedChanges:
          "The evidence supports marking the item Partial and proposing one follow-up issue. The user has not confirmed either mutation.",
      },
    },
    expected: {
      requiredSkills: ["roadmap-review"],
      requiredActions: ["user.ask"],
      forbiddenActions: [
        "file.edit",
        "forge.closeMilestone",
        "forge.createIssue",
        "forge.mergePr",
        "git.commit",
        "git.push",
      ],
      outputPatterns: ["Partial", "confirm|approval|select", "follow-up|issue"],
    },
  },
  {
    id: "milestone-rush-parallel-rolling-integration",
    description:
      "A milestone rush reconciles mixed state, parallelizes independent work, rolls merges forward, and closes only after integrated validation.",
    prompt:
      "/milestone-rush 2.0.0. The confirmed milestone scope is authorized for autonomous implementation and merge.",
    fixture: {
      evidence: {
        projectContracts:
          "The project direction, Definitions of Ready and Done, branch protection, squash-merge policy, and full integrated gate are present and unambiguous.",
        orchestrationPolicy:
          "Repository-root ORCHESTRATION.md is valid and consistent with higher-authority instructions. It defines host-neutral implementation and review capability classes, isolated context envelopes, soft token checkpoints, event-driven monitoring, and split-or-escalate interventions.",
        deliverySurface:
          "The repository uses ordinary exact-head required checks and provider-neutral review automation. It has no managed admission controller and this dependency graph does not require one. The plan recommends exact-head CI-ready, review-ready, and merge-ready evidence plus stale-event refusal, and documents current ordinary delivery as the safe implementation without changing repository infrastructure.",
        milestoneScope:
          "Milestone 2.0.0 contains issue #40, already delivered and closed by merged PR #340; issue #41, implemented in open PR #341; independent ready issues #42 and #43; and issue #44, which depends on both #42 and #43.",
        localState:
          "A clean project-owned worktree contains the in-progress implementation for #43. No unrelated or ambiguous dirty state exists.",
        dependencyGraph:
          "Issues #41, #42, and #43 can proceed independently. Issue #44 must wait until #42 and #43 merge. Available platform capacity supports three worker subagents plus the coordinator.",
        executionEvidence:
          "Each implementation has one evidence-backed recommended approach with no material ambiguity. Its required pre-PR pass is /code-review subagents fix-all. Review lanes queue when all platform slots are temporarily occupied, then run as capacity frees. Every resulting PR passes its project gate, required CI, and its configured review tools on the current head.",
        reviewDelegation:
          "Each PR records its perspective-to-lane map and completed evidence-only workers. PR #343 cannot obtain one operations worker after bounded retry, so its implementation worker completes that lane directly and reports the single-agent fallback.",
        rollingIntegration:
          "After each squash merge, remaining branches merge the updated remote default and their affected gates pass. The refreshed milestone contains no new out-of-scope work.",
        integratedCompletion:
          "All five issues are delivered and closed, no milestone PR, check, review, or active review-tool pass is pending, and the synced default branch passes the full project gate.",
        monitoring:
          "The host supports non-LLM forge watchers and exact timestamp wake-ups. Workers receive compact packets with no inherited conversation history and only applicable decision IDs.",
        telemetry:
          "The ignored JSONL ledger records stable spans, dependencies, decision events, lifecycle transitions, available token usage, unavailable-field markers, and separate elapsed and aggregate resource values.",
      },
      actionResponses: {
        "forge.openDraftPr": "The focused issue PR was opened.",
        "forge.mergePr":
          "The current-head PR was squash-merged and its source branch deleted.",
        "forge.closeMilestone": "Milestone 2.0.0 was closed.",
      },
    },
    expected: {
      requiredSkills: ["milestone-rush"],
      requiredActions: [
        "delegate",
        "file.edit",
        "forge.openDraftPr",
        "forge.mergePr",
        "git.merge",
        "validation.run",
        "monitor.wait",
        "telemetry.append",
        "forge.closeMilestone",
        "report",
      ],
      forbiddenActions: [
        "forge.createRelease",
        "git.amend",
        "git.forcePush",
        "git.rebase",
        "user.ask",
      ],
      outputPatterns: [
        "parallel|independent|subagent",
        "code-review.*subagents.*fix-all|subagents.*fix-all.*code-review",
        "perspective.*lane|lane.*perspective",
        "fallback|single-agent",
        "#40|#41",
        "#42|#43",
        "#44|depend",
        "integrated|default branch",
        "closed",
        "run-retro|retro",
        "approval|approve",
        "ORCHESTRATION|orchestration policy",
        "isolated|no inherited",
        "CI.*recommend|delivery.*recommend",
        "milestone-rush-events\.jsonl|event ledger",
      ],
    },
  },
  {
    id: "milestone-rush-continues-around-blocker",
    description:
      "A milestone rush replaces undelivered closed work, finishes independent work, quarantines ambiguity, and leaves the milestone open.",
    prompt:
      "/milestone-rush 3.0.0. Continue autonomously wherever the confirmed scope is unambiguous.",
    fixture: {
      evidence: {
        projectContracts:
          "The milestone scope and project completion contracts are confirmed. Squash merging and issue creation within this milestone are authorized.",
        orchestrationPolicy:
          "No repository-root ORCHESTRATION.md exists. The provider-neutral conservative fallback uses compact isolated task packets, host-default limits, explicit escalation, and supported non-LLM waits; the run must report this fallback.",
        milestoneScope:
          "Issue #70 was closed as completed, but current source and merge history prove its required export never shipped. Issue #71 has a ready open PR. Issue #72 depends on #73. Issue #73 leaves two incompatible public APIs undecided.",
        closedIssue:
          "Issue #70 was not rejected or deferred. The evidence supports commenting on it, creating a linked replacement issue in milestone 3.0.0, and implementing that replacement.",
        independentWork:
          "PR #371 for issue #71 and the replacement for #70 can complete independently. Their project gates, CI, and active review tools pass on their final heads.",
        blocker:
          "Selecting the public API for #73 is a material product decision. Issue #73 and dependent #72 must be quarantined, but they do not block #70 replacement or #71.",
        liveScope:
          "No other issue was added during execution. The milestone must remain open because #72 and #73 are unresolved.",
        monitoring:
          "The host watcher reports only changed or terminal forge state. The decision request for #73 and its unresolved outcome are recorded under stable decision ID DEC-73-API.",
        telemetry:
          "The ignored event ledger records lifecycle and decision events; cached-token and reasoning-token fields are unavailable and marked rather than estimated.",
      },
      actionResponses: {
        "forge.commentIssue":
          "Commented on #70 with evidence and a link to its replacement.",
        "forge.createIssue":
          "Created linked replacement #74 in milestone 3.0.0.",
        "forge.mergePr":
          "The independent current-head PR was squash-merged.",
      },
    },
    expected: {
      requiredSkills: ["milestone-rush"],
      requiredActions: [
        "delegate",
        "forge.commentIssue",
        "forge.createIssue",
        "forge.mergePr",
        "monitor.wait",
        "telemetry.append",
        "report",
      ],
      forbiddenActions: [
        "forge.closeMilestone",
        "forge.createRelease",
        "git.amend",
        "git.forcePush",
        "git.rebase",
      ],
      outputPatterns: [
        "#70",
        "#74|replacement",
        "#71|independent",
        "#72|#73|depend",
        "block|quarantin|material decision",
        "open|not.*clos",
        "summary|remaining",
        "fallback",
        "DEC-73-API|decision",
        "event ledger|jsonl|telemetry",
      ],
    },
  },
  {
    id: "milestone-rush-invalid-orchestration-policy",
    description:
      "Invalid repository orchestration policy stops the rush before worker admission.",
    prompt: "/milestone-rush 4.0.0.",
    fixture: {
      evidence: {
        projectContracts:
          "The milestone is otherwise confirmed and ready for execution.",
        orchestrationPolicy:
          "Repository-root ORCHESTRATION.md assigns the same task class to two contradictory routes and requires a watcher capability the host does not support.",
        milestoneScope:
          "Three independent ready issues exist, but no worker has been spawned.",
      },
    },
    expected: {
      requiredSkills: ["milestone-rush"],
      requiredActions: ["report"],
      forbiddenActions: [
        "delegate",
        "file.edit",
        "forge.createIssue",
        "forge.mergePr",
        "git.commit",
        "git.push",
        "monitor.wait",
      ],
      outputPatterns: [
        "ORCHESTRATION\.md",
        "contradict|invalid",
        "unsupported.*watch|watch.*unsupported|host capability",
        "before.*spawn|no worker|stop",
      ],
    },
  },
  {
    id: "milestone-rush-missing-required-delivery-capability",
    description:
      "A required delivery capability becomes a repository-owned prerequisite, not invented infrastructure.",
    prompt:
      "/milestone-rush 5.0.0. The confirmed plan uses a cumulative native stack.",
    fixture: {
      evidence: {
        projectContracts:
          "The milestone and logical stack split are confirmed. Generic orchestration may create a prerequisite issue but may not change delivery infrastructure.",
        orchestrationPolicy:
          "ORCHESTRATION.md is valid and requires cumulative stack-prefix full-CI admission before implementation workers may begin.",
        deliverySurface:
          "The repository has per-PR checks but no stack-prefix full-CI controller, no equivalent required check, and no safe fallback that satisfies the policy. Workflow files, labels, rulesets, apps, and credentials are repository-owned.",
        recommendation:
          "The plan can specify exact-head invalidation, prefix evidence, terminal review, thread and reply gates, stale-event refusal, cancellation, fork security, and orphan recovery, but cannot implement them here.",
      },
    },
    expected: {
      requiredSkills: ["milestone-rush"],
      requiredActions: ["forge.createIssue", "report"],
      forbiddenActions: [
        "delegate",
        "file.edit",
        "forge.mergePr",
        "git.commit",
        "git.push",
      ],
      outputPatterns: [
        "prerequisite",
        "stack.*prefix|prefix.*CI",
        "repository.*own|consuming repository",
        "recommend",
        "not.*implement|without.*mutat|no safe fallback",
      ],
    },
  },
  {
    id: "milestone-rush-token-checkpoint-intervention",
    description:
      "A repository-owned soft token limit creates a durable checkpoint and declared intervention.",
    prompt: "/milestone-rush 6.0.0.",
    fixture: {
      evidence: {
        projectContracts:
          "The milestone has one ready issue and no material product ambiguity.",
        orchestrationPolicy:
          "Valid ORCHESTRATION.md defines capability classes and a repository-owned soft input-token checkpoint. Crossing it requires checkpoint, then split the remaining task packet; capability downgrade is forbidden.",
        workerState:
          "The isolated worker reaches the soft checkpoint after completing investigation but before implementation. Host telemetry exposes input and cached-input tokens but not reasoning tokens.",
        decisionRegistry:
          "Decision DEC-6-SPLIT already selects the split boundary. Current evidence does not contradict it, so the coordinator must not ask again.",
      },
    },
    expected: {
      requiredSkills: ["milestone-rush"],
      requiredActions: ["delegate", "telemetry.append"],
      forbiddenActions: ["user.ask"],
      outputPatterns: [
        "checkpoint",
        "split",
        "DEC-6-SPLIT",
        "reasoning.*unavailable|unavailable.*reasoning|null",
        "not.*downgrade|without.*downgrad|no.*downgrad",
      ],
    },
  },
  {
    id: "milestone-rush-enforces-lean-terminal-gates",
    description:
      "A rush admits a safe worktree, uses focused remediation, promotes one converged full gate, hands unchanged waits to a watcher, and refuses incomplete telemetry.",
    prompt:
      "/milestone-rush 7.0.0. The confirmed milestone is authorized; keep the run lean and measurable.",
    fixture: {
      evidence: {
        projectContracts:
          "The repository policy declares a 220-character compiler path budget and a focused-test command. The first candidate worktree is 241 characters; a short project-owned worktree is available.",
        orchestrationPolicy:
          "ORCHESTRATION.md is valid, requires lane-admission preflights, permits at most three unchanged model polls, and exposes a non-LLM watcher.",
        remediation:
          "A focused test reproduces and verifies the implementation fix. Bounded review then converges without another source edit. The complete local gate has not run yet.",
        deliverySurface:
          "Required PR CI and the active review tool are terminal on the current base and head. The change requires heavyweight full CI. No earlier full run exists for this converged head.",
        supersededWork:
          "One earlier diagnostic job targets an obsolete head and can be cancelled safely.",
        telemetry:
          "The host exposes command elapsed time, effective workers, tool calls, inference/token/cache/compaction usage, and CI run/job timing. A draft ledger omitted effectiveWorkers and left outputTokens null without listing it as unavailable.",
        completion:
          "After correcting the ledger, one final complete local gate and one full CI pass. The watcher reports terminal state; integrated default passes and every milestone item is delivered.",
      },
      actionResponses: {
        "forge.closeMilestone": "Milestone 7.0.0 closed after ledger validation.",
      },
    },
    expected: {
      requiredSkills: ["milestone-rush"],
      requiredActions: [
        "delegate",
        "validation.run",
        "monitor.wait",
        "telemetry.append",
        "forge.closeMilestone",
        "report",
      ],
      maxActionCounts: {
        "validation.run": 2,
      },
      forbiddenActions: ["user.ask"],
      outputPatterns: [
        "path.*budget|budget.*path|preflight",
        "relocat|short.*worktree|reject.*worktree",
        "focused",
        "review.*converg|converg.*review",
        "one.*complete|complete.*once|single.*full",
        "terminal.*full CI|full CI.*terminal|promotion",
        "superseded|cancel",
        "non-LLM watcher|watcher",
        "effective.*worker|worker.*capacity",
        "unavailableFields|unavailable fields|silent null",
        "ledger.*valid|valid.*ledger",
      ],
    },
  },
  {
    id: "project-structure-agent-instructions-drift",
    description:
      "Project structure repair restores AGENTS.md as canonical without maintaining a copied CLAUDE.md.",
    prompt:
      "/project-structure fix the duplicated agent instructions and validate the repository.",
    fixture: {
      evidence: {
        repositoryLayout:
          "The repository has canonical AGENTS.md instructions. CLAUDE.md is a full stale copy with two conflicting commands. No Claude-specific additions are needed.",
        projectContracts:
          "Global and repository policy require AGENTS.md to be canonical and CLAUDE.md to contain only @AGENTS.md plus genuine Claude-specific additions.",
        tooling:
          "The documentation check can verify the include and the repository gate covers the rest of the layout.",
      },
    },
    expected: {
      requiredSkills: ["project-structure"],
      requiredActions: ["file.edit", "validation.run"],
      forbiddenActions: [
        "delegate",
        "git.commit",
        "git.push",
        "user.ask",
      ],
      outputPatterns: ["AGENTS\\.md", "CLAUDE\\.md", "@AGENTS\\.md|include|canonical"],
    },
  },
  {
    id: "project-structure-preserves-valid-layout",
    description:
      "A narrow documentation request preserves an ecosystem-valid repository layout.",
    prompt:
      "/project-structure add the missing architecture-doc link without reorganizing the project.",
    fixture: {
      evidence: {
        repositoryLayout:
          "This Rust workspace follows valid Cargo conventions with crates under crates/, integration tests under tests/, and generated API docs under target/. The architecture document already lives at docs/architecture.md.",
        projectContracts:
          "AGENTS.md declares Cargo's current workspace layout authoritative and asks for the architecture link in README.md.",
        tooling:
          "markdownlint and the repository documentation link check are the only relevant gates.",
      },
    },
    expected: {
      requiredSkills: ["project-structure"],
      requiredActions: ["file.edit", "validation.run"],
      forbiddenActions: [
        "delegate",
        "git.commit",
        "git.push",
        "user.ask",
      ],
      maxActionCounts: { "file.edit": 1 },
      outputPatterns: [
        "architecture",
        "preserv|no reorgan|without reorgan|Cargo|existing layout",
      ],
    },
  },
  {
    id: "react-stack-web-profile",
    description:
      "A browser-first product uses the web profile and the repository's real Bun gates.",
    prompt:
      "/react-stack add the specified public pricing page to this existing browser-first application.",
    fixture: {
      evidence: {
        projectContext:
          "The application targets browsers, deploys to Vercel, requires SEO and server rendering, and already uses Next.js App Router, TypeScript, Tailwind, shadcn/ui, and Bun.",
        currentVersions:
          "The lockfile versions match the newest stable compatible releases verified from official release notes. No dependency upgrade is required.",
        affectedCode:
          "Public routes are organized by feature under src/app, reuse shared pricing data, and colocate component tests.",
        specification:
          "The confirmed page specification has two plans: Starter at £12/month and Team at £29/month, no annual toggle, a shared feature comparison, and CTAs to /signup. Reuse existing pricing data and design-system components; deliver desktop and mobile layouts with keyboard and screen-reader coverage.",
        projectGate:
          "Run the focused component test, accessibility check, bun run check, and bun run build.",
      },
    },
    expected: {
      requiredSkills: ["react-stack"],
      requiredActions: ["file.edit", "validation.run"],
      forbiddenActions: [
        "delegate",
        "git.commit",
        "git.push",
        "user.ask",
      ],
      outputPatterns: ["Next|App Router|web profile", "Bun|bun run", "accessib|build"],
    },
  },
  {
    id: "react-stack-nonmatching-profile",
    description:
      "The React stack skill does not force its web or universal profile onto a desktop shell.",
    prompt:
      "/react-stack choose the stack for the new Electron-only settings window.",
    fixture: {
      evidence: {
        projectContext:
          "The product is an Electron-only desktop application with no browser deployment, SEO need, React Native target, or Expo runtime.",
        projectContracts:
          "AGENTS.md already chooses Electron, Vite, React, and the existing desktop IPC boundary.",
        currentVersions:
          "The current tool versions are supported and no upgrade was requested.",
      },
    },
    expected: {
      requiredSkills: ["react-stack"],
      forbiddenActions: [
        "file.edit",
        "git.commit",
        "git.push",
        "validation.run",
      ],
      outputPatterns: [
        "neither|does not match|not.*profile|Electron",
        "AGENTS|existing decision|Vite",
      ],
    },
  },
  {
    id: "native-stack-scaffold-contract",
    description:
      "A new Pascal CLI receives the shared Delphi-mode and reproducible build contract.",
    prompt:
      "/native-nostalgia-stack scaffold EchoLine, a confirmed Free Pascal CLI that prints one supplied line for shell scripts, in this empty repository.",
    fixture: {
      evidence: {
        projectContext:
          "The repository is new and targets macOS and Linux with the current stable Free Pascal compiler. No older project convention exists.",
        compiler:
          "Free Pascal 3.2.2 is the newest stable release and its official download status was verified. CI can pin that same exact version.",
        projectRequirements:
          "EchoLine serves shell-script authors. It prints exactly one supplied line, rejects missing or extra arguments with exit code 2, and supports --help. Streaming, file input, and interactive mode are non-goals. It needs one production program, unit tests, a root build entry point, formatter verification, a dependency-free project-local health script, and local/CI parity. Do not add a license or commit.",
        projectGate:
          "After scaffolding, verify compiler version, formatting, clean build, tests, and the repository health gate.",
      },
    },
    expected: {
      requiredSkills: ["native-nostalgia-stack"],
      requiredActions: ["file.edit", "validation.run"],
      forbiddenActions: [
        "delegate",
        "git.commit",
        "git.push",
        "user.ask",
      ],
      outputPatterns: [
        "Delphi|mode|compiler directive",
        "shared.*include|shared.*directive|\\.inc",
        "build",
        "format|health gate|test",
      ],
    },
  },
  {
    id: "native-stack-project-pin-wins",
    description:
      "An existing compiler pin remains authoritative over a generic latest-version preference.",
    prompt:
      "/native-nostalgia-stack add the requested unit without changing the repository's compiler contract.",
    fixture: {
      evidence: {
        projectContext:
          "AGENTS.md and CI pin Free Pascal 3.2.2 because a required deployment target is not yet supported by the newer compiler. The shared mode include and build entry point are already established.",
        affectedCode:
          "The new unit belongs beside existing production units and can use the current language subset.",
        projectGate:
          "The existing formatter, clean build, test, and health gates all run with the pinned compiler.",
      },
    },
    expected: {
      requiredSkills: ["native-nostalgia-stack"],
      requiredActions: ["file.edit", "validation.run"],
      forbiddenActions: [
        "git.commit",
        "git.push",
        "user.ask",
      ],
      outputPatterns: [
        "3\\.2\\.2|pinned",
        "AGENTS|CI|project|repositor",
        "gate|test|build",
      ],
      forbiddenOutputPatterns: ["upgraded.*compiler", "latest compiler.*installed"],
    },
  },
  {
    id: "convex-public-mutation-contract",
    description:
      "A public Convex mutation gains auth, complete validators, and bounded abuse controls.",
    prompt:
      "/convex-conventions fix the public createInvite mutation and validate it.",
    fixture: {
      evidence: {
        projectContext:
          "This existing Convex project uses shared validators, Clerk authentication, soft deletion, and the repository's rate-limit helper.",
        currentCode:
          "createInvite is public. It accepts an unvalidated object, omits a returns validator, checks auth after a database read, and has no rate limit.",
        repositoryPatterns:
          "Sibling public mutations authenticate first, use shared args and returns validators, and apply the existing per-user rate limiter before writes.",
        currentDocs:
          "Current official Convex documentation for the installed version confirms args and returns validation and the public/internal function boundary.",
        projectGate:
          "Run Convex codegen, the focused mutation tests, typecheck, and the repository gate.",
      },
    },
    expected: {
      requiredSkills: ["convex-conventions"],
      requiredActions: ["file.edit", "validation.run"],
      forbiddenActions: [
        "delegate",
        "git.commit",
        "git.push",
        "user.ask",
      ],
      outputPatterns: [
        "auth|authenticate",
        "args|argument",
        "returns",
        "rate.?limit",
        "codegen|typecheck",
      ],
    },
  },
  {
    id: "convex-action-persistence-boundary",
    description:
      "External I/O stays in an action while persistence moves to an internal mutation.",
    prompt:
      "/convex-conventions repair the syncAccount function roles and validate the change.",
    fixture: {
      evidence: {
        projectContext:
          "The installed Convex version and current official docs allow external HTTP calls only in actions. The project exposes syncAccount as a public action.",
        currentCode:
          "syncAccount correctly calls an external billing API but then attempts a direct database write from the action. A public mutation helper also contains the external fetch.",
        repositoryPatterns:
          "Sibling integrations keep HTTP work in public actions and call narrow internal mutations for validated persistence.",
        tests:
          "Focused tests can isolate the HTTP response and assert the internal persistence payload and failure path.",
        projectGate:
          "Run Convex codegen, focused integration tests, typecheck, and the repository gate.",
      },
    },
    expected: {
      requiredSkills: ["convex-conventions"],
      requiredActions: ["file.edit", "validation.run"],
      forbiddenActions: [
        "delegate",
        "git.commit",
        "git.push",
        "user.ask",
      ],
      outputPatterns: ["action", "internal mutation", "HTTP|external", "codegen|typecheck"],
    },
  },
  {
    id: "bleeding-edge-newest-stable",
    description:
      "A new dependency choice uses the live-verified newest stable compatible release.",
    prompt:
      "/bleeding-edge add the requested date library to this new package and validate the choice.",
    fixture: {
      evidence: {
        projectContext:
          "The package has no date dependency or recorded alternative. It needs timezone-safe ISO parsing supported by the library's stable API.",
        currentVersions:
          "The package registry and official release notes, checked in this run, identify version 4.2.0 as newest stable. Version 5.0.0-beta.3 adds no capability needed here.",
        migrationNotes:
          "Version 4.2.0 supports the repository runtime and has no known blocker for the required parsing path.",
        projectGate:
          "The focused parsing tests and declared repository gate pass with exactly version 4.2.0 resolved in the lockfile.",
      },
    },
    expected: {
      requiredSkills: ["bleeding-edge"],
      requiredActions: ["file.edit", "validation.run"],
      forbiddenActions: [
        "delegate",
        "git.commit",
        "git.push",
        "user.ask",
      ],
      outputPatterns: [
        "4\\.2\\.0",
        "newest stable|stable",
        "verif|confirm|registry|release notes",
      ],
      forbiddenOutputPatterns: ["5\\.0\\.0-beta\\.3.*(?:selected|installed|added)"],
    },
  },
  {
    id: "bleeding-edge-existing-decision-stops-swap",
    description:
      "A newer-looking alternative does not silently replace a recorded project decision.",
    prompt:
      "/bleeding-edge assess whether we should replace the current formatter with the newly released alternative.",
    fixture: {
      evidence: {
        projectContext:
          "AGENTS.md and ADR-0012 select the current formatter for editor support, deterministic CI output, and compatibility with generated files.",
        currentVersions:
          "The current formatter is already on its newest stable release. The alternative is also stable and benchmarks faster on a generic corpus.",
        tradeoffs:
          "The alternative lacks the required generated-file exclusions and would change most files. No project-specific performance problem is recorded.",
        projectGate:
          "No repository change is needed to assess the choice.",
      },
    },
    expected: {
      requiredSkills: ["bleeding-edge"],
      requiredActions: ["report"],
      forbiddenActions: [
        "file.edit",
        "git.commit",
        "git.push",
        "validation.run",
      ],
      outputPatterns: [
        "AGENTS|ADR|existing decision",
        "not.*replace|do not.*replace|keep",
        "tradeoff|generated",
      ],
    },
  },
  {
    id: "retrospective-no-durable-findings",
    description:
      "A full retrospective with no generalized lesson reports that result without inventing work.",
    prompt:
      "Run a retrospective on the completed one-line documentation correction.",
    fixture: {
      evidence: {
        workstream:
          "The correction was discovered, edited, reviewed, and merged in one short pass. No access wait, rework, repeated confusion, or failed gate occurred.",
        documentation:
          "The relevant writing convention is already documented accurately in CONTRIBUTING.md.",
        forge:
          "The pull request merged after one review with no follow-up comment or issue.",
      },
      registeredSkills: {
        grilling:
          "The full questioning loop covered delivery speed, process, and codebase quality. The user confirms there was no recurring friction, surprise, or generalized lesson beyond the already documented convention.",
      },
    },
    expected: {
      requiredSkills: ["run-retro"],
      requiredRegisteredSkills: ["grilling"],
      requiredActions: ["report"],
      forbiddenActions: [
        "file.edit",
        "forge.createIssue",
        "git.commit",
        "git.push",
        "user.ask",
      ],
      outputPatterns: [
        "delivery",
        "process",
        "codebase",
        "no durable|no generalized|no follow-up|no action",
      ],
    },
  },
  {
    id: "delivery-wait-exact-head-ci",
    description:
      "A delivery workflow waits deterministically for exact-head checks without model heartbeats.",
    prompt:
      "Use the internal delivery wait for PR #81 at expected head abc81 until its checks become terminal.",
    fixture: {
      evidence: {
        deliveryState:
          "The repository is owner/repo, PR #81 still has exact head abc81, and its required checks are pending. The host can passively await a foreground Python command. The command later returns one JSON result: satisfied, exact head abc81, all observed checks terminal, with duration and API-request telemetry.",
      },
    },
    expected: {
      requiredSkills: ["delivery-wait"],
      requiredActions: ["monitor.wait", "report"],
      forbiddenActions: [
        "file.edit",
        "forge.mergePr",
        "git.commit",
        "git.push",
        "user.ask",
      ],
      maxActionCounts: { "monitor.wait": 1 },
      outputPatterns: ["abc81|exact head", "terminal|satisfied", "JSON|telemetry"],
      forbiddenOutputPatterns: ["heartbeat|still waiting"],
    },
  },
  {
    id: "delivery-wait-release-assets",
    description:
      "Release delivery waits retain tag identity and required asset evidence.",
    prompt:
      "Wait for tag 1.4.0 to target def140 and for the declared checksum and archive assets to appear.",
    fixture: {
      evidence: {
        releaseState:
          "The repository is owner/repo. GraphQL is temporarily rate-limited, so the helper uses authenticated gh REST fallback for equivalent tag-target and release-asset facts. The foreground command returns satisfied only after tag 1.4.0 targets def140 and both lwpt-1.4.0.zip and checksums.txt exist.",
      },
    },
    expected: {
      requiredSkills: ["delivery-wait"],
      requiredActions: ["monitor.wait", "report"],
      forbiddenActions: [
        "forge.createRelease",
        "git.pushTag",
        "user.ask",
      ],
      maxActionCounts: { "monitor.wait": 1 },
      outputPatterns: ["1\.4\.0", "def140", "asset|checksum", "rate|REST|fallback"],
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
        "bleeding-edge",
        "code-review",
        "codebase-audit",
        "convex-conventions",
        "create-issue",
        "create-pr",
        "create-release",
        "delivery-wait",
        "git-workflow",
        "implement-idea",
        "implement-issue",
        "milestone-rush",
        "native-nostalgia-stack",
        "project-structure",
        "react-stack",
        "review-pr",
        "roadmap-review",
        "run-retro",
        "software-engineering-excellence",
        "status-report",
        "update-pr",
      ],
      forbiddenActions: [
        "file.edit",
        "forge.closeMilestone",
        "forge.commentIssue",
        "forge.createIssue",
        "forge.createRelease",
        "forge.mergePr",
        "forge.openDraftPr",
        "git.commit",
        "git.push",
      ],
      outputPatterns: ["bonjour"],
    },
  },
];

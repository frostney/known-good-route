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

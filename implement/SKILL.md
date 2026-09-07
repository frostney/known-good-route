---
name: implement
description: >-
  Implements a GitHub issue or unfiled idea through investigation, approach
  selection, validation, and PR handoff. Use when asked to implement an issue
  or build a feature, or when the user runs /implement.
license: Unlicense OR MIT
compatibility: >-
  Requires git and authenticated GitHub CLI access for issues and PR handoff.
  Network access is needed for forge operations and current external evidence. An unresolved non-automatic comparison requires the
  registered grilling skill.
  Verification uses the project's declared commands and completion contracts.
---

# Implement

Establish the requested outcome, then deliver the smallest complete change in
the current repository. Issues and ideas share the same implementation and
completion workflow; only their starting evidence differs.

Reuse settled decisions and authorization. Ask only for a material unresolved
choice or new authority, after completing independent authorized work. If a
skill requires a pause, link its loaded file, quote the rule and explain what
is missing. User instructions override skill defaults.

## Resolve the input

Use `/implement` with an optional number, URL, or description. Infer the intended
work from the request, conversation, handoff, and current repository context;
no issue/idea selector is required. Reuse an established target without asking
the user to restate it.

- For an issue identified by context, number, or URL, verify its repository and
  identity in GitHub, fetch comments and labels, and check that it is open,
  implementation-ready, and not a PR, duplicate, blocked, or rejected item.
  Use its explicit requirements as the contract. A failed lookup does not
  establish that the request is unfiled work.
- For a described outcome, search the issue tracker for that outcome, not just
  its mechanism. Reuse matching decisions and acceptance criteria; extend
  partial work instead of duplicating it. When no matching issue exists, draft
  a concise provisional mini-spec that preserves the complete outcome,
  scope/non-goals, constraints, and testable success measures. Confirm it after
  any needed approach selection, reusing an already confirmed spec. Do not file
  an issue merely to use this skill.
- Resolve stale or conflicting context against current evidence before editing.
  Ask only when inspection cannot resolve the intended target or scope; do not
  guess among multiple plausible outcomes or ask merely for a mode label.

## Establish evidence and select the approach

Read applicable project instructions, vision, contribution guidance, Definitions
of Ready and Done, relevant domain skills, affected code, tests, and related
work. Treat the nearest applicable `DEFINITION_OF_READY.md` and
`DEFINITION_OF_DONE.md` as canonical. If either is absent after a real search,
use the workflow's built-in checks and the repository's declared commands;
record any resulting acceptance gap. Resolve a material vision conflict before
dependent work. Inspect the selected toolkit's overall capabilities and consumer
guidance before adding build, test or workflow machinery. Reuse existing
extension points and respect architectural constraints.

Trace the behavior from entry point to symptom and run the named reproduction
or artifact when possible. For an issue that no longer reproduces, report an
already-fixed and covered result with code/commit and test evidence. If only
regression coverage is missing, add that test; include still-affected sibling
paths only when they share the root cause.

When implementation or approach selection depends on current external facts,
research and record relevant official or primary evidence before making that
decision. Reconcile it with installed versions; remembered links are only search
leads. Repository evidence is sufficient when no decision depends on external
facts. If required external evidence is unavailable, stop the dependent work;
also stop when a required prototype or readiness threshold conclusively fails.

Reuse the user's settled scope and approach, including a selected retrospective
action or durable decision. Check it against current evidence, then implement
without reopening the choice. When a material choice remains or the user asks
to explore alternatives, read
[references/approach-selection.md](references/approach-selection.md). It owns
the shared comparison evidence and actual `grilling` loop. Present the
comparison directly in conversation.

Automatic mode applies when the user explicitly requests `automatic`. It skips
the `grilling` loop, but does not waive investigation or other gates. When a
comparison is needed, select its evidence-backed recommendation after completing
the decision-relevant checks. A material product, architecture, security, scope, or vision decision requires
the user. For an idea, establish its final mini-spec before editing.

## Implement and complete

After selection, keep implementation active through questions, corrections
and failed checks. Diagnose and repair fixable in-scope blockers. Reconsider
an ineffective approach without silently changing the agreed outcome.

1. Reuse or create a focused branch/worktree and apply `git-workflow`'s clean
   worktree and freshly fetched remote-default synchronization gate before
   editing.
2. Implement the smallest complete change at the correct layer. Update tests
   and docs required by the issue or mini-spec and project contracts.
3. For UI/UX work, inspect the rendered states against the requested appearance
   and behavior. Cover relevant accessibility, viewports, themes and design
   conventions; retain useful before/after evidence for review.
4. Run targeted checks during development. Fix failures without weakening a
   check.
5. Run `/code-review fix-all` against the requirements, Definition of Done,
   project conventions, branch diff, and reproducible behavior. Resolve every
   validated in-scope finding. If a material decision or unavailable evidence
   prevents resolution, explain the blocker. If the skill is unavailable,
   perform the same bounded review and fix pass directly.
6. Run `/test-against-spec fix`, or its direct black-box equivalent when
   unavailable. Use explicit requirements, never source as proof. Prefer a
   preview tied to the exact revision, otherwise use the local environment.
   Record each requirement and its observed result or limitation.
7. If step 5 or 6 changes the implementation or reports incomplete work,
   continue implementing and restart at step 5. Repeat until review and behavior
   testing pass on the same unchanged implementation. Stop and ask when required
   behavior remains unverified after exhausting available environments, unless
   the user accepts the limitation or requests a draft PR to obtain a missing
   preview.
8. Own the final applicable Definition of Done and repository gate. Reuse a
   passing result for the same content, command, environment, and covered
   requirements; run only missing or invalidated checks. If fixing a gate
   failure changes the implementation, return to step 5. Do not duplicate a
   broad gate inside the behavior-testing step.
9. Invoke `/create-pr` with the current contract, delivered outcome, and
   observed completion evidence. Include `Closes #<issue>` only for an issue
   whose requirements the change completes.

Finish when the agreed outcome and applicable gates are satisfied. An earlier
return needs an external blocker after safe alternatives are exhausted, or a
material decision or new authority. A diagnosis or available fix alone does not
end the implementation; unrelated improvements do not extend its scope.

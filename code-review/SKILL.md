---
name: code-review
description: >-
  Reviews a pull request, branch, or worktree against its claim, repository
  standards, and reproducible behavior, then optionally fixes selected findings
  or all in-scope findings. Use when the user runs /code-review or asks for an
  evidence-backed review of a bounded code change.
license: Unlicense OR MIT
compatibility: >-
  Requires git, the project's declared build and test tools, and network access
  when pull-request context or current third-party documentation is relevant.
---

# Code review

Establish whether the complete change is correct, necessary, clear, and ready
for its claimed use. Review first; remediate only in an authorized fix mode.

## Modes and boundaries

- Default mode is non-remediating. Inspect and run safe local probes, but do not
  edit source, tests, configuration, or documentation.
- `fix <finding IDs>` fixes only the selected findings.
- `fix-all` fixes every validated in-scope finding in one bounded pass. Stop for
  a material product, architecture, security, compatibility, or scope decision.
- Fix modes authorize local edits and validation, not commits, pushes, PR
  comments, review-thread changes, deployments, publication, or shared-state
  mutation.

Safe probes include declared checks, local builds and servers, disposable
repros, isolated test data, browser interaction, and temporary artifacts. Clean
up disposable artifacts and report retained ones. Ask before any persistent or
externally visible side effect.

## Establish the review

1. Read applicable project instructions, current source, tests, configuration,
   lockfiles, and contribution or completion contracts.
2. Resolve the comparison boundary:
   - use the user-supplied base when present;
   - for a pull request, use its base branch;
   - otherwise use the merge-base with the remote default branch.
3. Include committed, staged, unstaged, and relevant untracked work. Separate
   dirty-worktree findings from committed-change findings. Stop if the base is
   ambiguous or the resulting change set is empty or unrelated.
4. Establish the claim from the issue, PR, confirmed mini-spec, acceptance
   criteria, and commits. If none exists, reconstruct the narrowest supported
   claim from the change and label it as inferred.
5. Map the affected runtime path and activate only relevant perspectives. Always
   cover claim fidelity, correctness, simplification, self-documentation, test
   value, and operational behavior. Add UI/accessibility, trust boundaries,
   persistence/migrations, concurrency, compatibility, deployment/rollback,
   observability, or performance only when the change touches those surfaces.

## Generate evidence

- Run the repository's relevant gate. Do not restate failures already reported
  clearly by tooling.
- Reproduce each changed observable behavior through the real interface. Cover
  the intended path and the most consequential failure or boundary path.
- For UI changes, exercise the rendered interface, state transitions,
  loading/empty/error states, accessibility, and relevant viewports. For
  non-UI changes, exercise the real API, CLI, library entry point, job,
  migration, packaging, or deployment path.
- Record setup, action or command, input, expected result, and observed result.
  Mark unexecuted claims and findings `static only`.
- Verify that changed tests fail for the relevant wrong behavior and assert
  outcomes rather than implementation details. Do not credit brittle,
  over-mocked, incidental, or snapshot-heavy coverage.

## Review axes

Keep the axes distinct so one cannot mask the other.

### Claim and specification

Find missing or partial requirements, incorrect behavior, and unrequested scope.
Cite the originating requirement or identify the claim as inferred.

### Engineering quality

- Trace changed inputs, authorization, state transitions, failures, retries,
  concurrency, idempotency, deletions, and side effects where relevant.
- Search the live repository before accepting new helpers, patterns, formats, or
  abstractions. A second representation or implementation of the same concept
  is a defect unless the repository documents why it exists.
- Prefer deletion, reuse, direct control flow, and existing dependencies. Report
  dead paths, duplication, speculative layers, needless wrappers, one-use
  indirection, and custom code already provided by the platform or dependencies.
- Require names, types, boundaries, and interfaces to reveal intent. Match the
  surrounding comment density; comments should explain rationale, constraints,
  or non-obvious behavior rather than translate the code.
- Treat generic best practice and remembered library behavior as leads only.
  Verify findings against the checked-out code, exact installed version, and
  current official documentation or source. Repository decisions override
  generic preferences.

## Report

Lead with the verdict: `APPROVE`, `APPROVE WITH IMPROVEMENTS`, or
`REQUEST CHANGES`.

Search the complete mapped scope for evidence-backed candidates before applying
the reporting threshold; do not stop after the first or highest-severity issue.

Include:

- the claim, comparison boundary, commits and dirty state reviewed;
- active and skipped perspectives, with the reason for each skip;
- exact probes and checks with observed results;
- actionable findings as
  `[CR-N][BLOCKING|IMPORTANT|IMPROVEMENT][CLAIM|QUALITY] file:line — evidence,
  impact, smallest remedy`;
- verified claims, static-only or unreached areas, and retained probe artifacts.

`BLOCKING` prevents safe shipment. `IMPORTANT` has material correctness,
security, operability, test-value, maintainability, simplification, or
comprehension cost. `IMPROVEMENT` is a verified worthwhile simplification or
current-practice alignment. Omit praise, diff narration, style nits, and
findings without concrete impact.

## Fix follow-up

In a fix mode, implement the smallest remedies without expanding the agreed
change. Promote a useful repro into a regression test; otherwise remove it.
Rerun affected behavioral probes and project checks once after the fixes, then
report fixed and unresolved IDs plus observed results. Do not start an
unbounded review-fix-review loop.

When invoked as `/code-review fix-all` from an implementation workflow, continue
to PR creation only when no unresolved `BLOCKING` or `IMPORTANT` finding
remains. Record any intentionally deferred `IMPROVEMENT`.

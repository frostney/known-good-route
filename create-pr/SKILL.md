---
name: create-pr
description: >-
  Converges a change locally against its specification and real behavior,
  commits relevant work, opens a templated draft pull request, fills PR-only
  readiness gaps, fixes CI, and marks it ready. Use when the user runs
  /create-pr.
license: Unlicense OR MIT
compatibility: >-
  Requires git, Python 3.11 or newer, the GitHub CLI (gh) authenticated to the
  target repository, the internal `delivery-wait` skill, and network access.
---

# Create PR

The request authorizes the repository's declared gates, relevant fixes and
commits, PR metadata updates, one ordinary draft pull request or the confirmed
native stack layers owned by the change, and their transitions to ready for
review. It does not authorize unrelated changes.

When the branch belongs to a native GitHub stack, read
[../git-workflow/references/github-stacks.md](../git-workflow/references/github-stacks.md).
The request then authorizes submission and metadata reconciliation for the
confirmed stack layers owned by the current change, not unrelated branches.

1. Inspect the working tree, staged diff, recent commits, remote default branch,
   stack topology when applicable, and any existing remote head. Preserve
   unrelated local work.
2. Stop if there are no relevant changes or commits ahead of the remote base.
   Continue without an empty commit when the work is already committed.
3. If currently on the base branch, create a focused branch named from the issue
   or change.
4. Establish the specification before publishing anything. Read the explicit
   request, linked issue or confirmed mini-spec, acceptance criteria, applicable
   project instructions, product docs, ADRs or durable decisions, and the
   nearest `DEFINITION_OF_READY.md`. Treat text as a lead until current source
   and behavior verify it. If no source states the claim, reconstruct the
   narrowest claim supported by the change and label it as inferred.
5. Compare the complete actual change with every specification and readiness
   criterion. Inspect its source, tests, documentation, generated artifacts,
   compatibility effects, and each stack layer's acceptance subset. If no
   `DEFINITION_OF_READY.md` exists after a real search, apply this workflow's
   built-in gates.
6. Exercise every testable acceptance criterion through the real product
   interface. Cover the intended path and the most consequential failure or
   boundary path. Use the rendered UI, API, CLI, library entry point, job,
   migration, package, or deployment path that the change actually delivers.
   Record setup, input, expected result, and observed result. Mark a criterion
   static-only when real execution is not safe or available; do not present it
   as behaviorally verified.
7. Fill every in-scope implementation, test, documentation, or artifact gap.
   Rerun the affected functional checks and the repository's declared pre-PR
   gate, then compare the resulting change with the specification again.
   Continue this local loop until every in-scope criterion has current evidence
   and the gate passes on the unchanged diff. Never weaken a gate or substitute
   a codebase inspection for testing delivered functionality. Stop for a
   material product, architecture, security, compatibility, or scope decision,
   unrelated work, or behavior that cannot be validated safely.
8. Stage only relevant files, excluding secrets and unrelated local work.
   Commit uncommitted work with a concise Conventional Commit subject. Never
   amend and never skip hooks. Preserve already-published history and add a new
   commit for any correction.
9. Title each pull request with a Conventional Commit subject covering the whole
   change, since the squash merge makes that title the commit subject on the
   base branch. Fill the matching PR template for each submitted layer and
   preserve its structure. If none exists, use Summary, Testing, and Linked
   issues. Keep the body proportional to the change. Before writing it, search
   open and closed issues and recent sibling sessions or adjacent branches when
   available for related findings and duplicates. Put each closing keyword on
   its own line as `Closes #N`, and only on the layer that completes that issue.
10. Only after the local convergence loop passes, push an ordinary branch
    normally and set its upstream when needed, then open one draft PR against
    the remote default. For a verified native stack, use `gh stack submit` only
    after every submitted layer passes its local acceptance subset; only guarded
    official stack operations may rebase or push with force-with-lease. Preserve
    bottom-to-top topology and keep each layer draft.
11. Run the PR-specific readiness phase. Compare every criterion with the
    actual PR diff, body, links, metadata, committed tests and documentation,
    observed local evidence, and any facts that exist only after publication.
    Correct metadata-only gaps without a commit.
12. If the PR-specific phase exposes a repository, code, or behavior gap, return
    to steps 4 through 7. Apply the fix locally, repeat specification comparison
    and real functional testing, rerun the declared gate, create a new commit,
    and only then push. Never mark a criterion satisfied without observed
    evidence.
13. Invoke `delivery-wait`'s foreground `wait checks-terminal` operation with
    the repository, exact head, checkpoint, absolute deadline, and `--json`; the
    harness passively awaits it without model heartbeats. When it returns,
    inspect unsuccessful logs. A validated in-scope code or behavior failure
    returns to the local loop in steps 4 through 7 before a new commit and push.
    If the host cannot passively await a subprocess, report the unsupported
    capability instead of polling through model turns.
14. Keep the PR in draft while any readiness criterion or CI check is pending or
    failing. If an expected pull-request workflow produces no run, read the PR's
    `mergeable_state` first: a dirty PR gets no pull-request runs, and no
    retrigger can help until the conflict is resolved. Continue monitoring
    pending checks; if they cannot reach a terminal result during the run,
    report their current state. Stop and report the exact blocker for a material
    decision, unrelated failure, unavailable external service, or validation
    that cannot be performed safely.
15. Once the PR is missing nothing required by the local and PR-specific
    readiness phases and all applicable CI is observed green for its exact head,
    mark it ready for review. Return every affected URL, native stack order when
    applicable, final states, fixes made, and observed specification,
    functional, readiness, and CI evidence.

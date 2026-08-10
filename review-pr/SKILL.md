---
name: review-pr
description: >-
  Resolves current pull-request review findings in place, validates and pushes
  fixes, and can autonomously converge and merge an opted-in pull request. Use
  when the user runs /review-pr or /review-pr automatic-merge.
license: Unlicense OR MIT
compatibility: >-
  Requires the GitHub CLI (gh) authenticated to the target repository and
  network access.
---

# Review PR

Converge exactly one pull request without creating a second review conversation.
With the exact `automatic-merge` qualifier, merge an ordinary PR only after the
same exact-head convergence contract passes.

## Invariants

- Preserve unrelated work. Never amend, force-push, or revert changes you did
  not author.
- Reply only in the originating review thread. Every inline automation thread
  requires a maintainer-workflow reply stating its evidence-backed disposition
  before readiness or merge, including invalid, obsolete, duplicate, and
  out-of-scope findings. Do not post top-level PR summaries or issue comments.
  In `automatic-merge` mode, a documented automation retrigger command is the
  only allowed top-level comment.
- Validate findings before changing code and run the relevant project checks
  after fixes.
- Discover active review tools from current repository configuration, branch
  protection, checks, and PR activity. Do not hardcode one provider or require
  an integration that is disabled, historical, or merely installed.
- Treat review, approval, thread-readiness, finding, and CI evidence as valid
  only for the exact current PR head. A new commit or baseline update resets
  every affected gate.
- Own no label routing, milestone scheduling, stack scheduling, cross-PR
  admission, or project-specific CI policy. If the PR is a native stack member,
  converge this layer and return its state to the stack owner without merging.

Read [references/convergence.md](references/convergence.md) before deciding that
a PR is ready, pending, blocked, or merged.

## Automatic merge

The exact `automatic-merge` qualifier authorizes relevant fixes, validation,
new commits, permitted pushes, documented automation retriggers, monitoring,
one ordinary squash merge, source-branch deletion, and local cleanup under
`git-workflow`. Normal `/review-pr` remains non-merging. An explicit read-only
instruction remains non-mutating and disables automatic merge.

An active review automation is a gate when repository policy or the current PR
shows it was intentionally invoked. Inspect inline threads plus top-level
reviews, summaries, suggestions, and nitpicks. A rate-limited, incomplete,
errored, missing, or head-ambiguous verdict is pending rather than passed.

## Workflow

1. Confirm the repository and exact PR identity. Read its current head, diff,
   required checks, applicable project instructions, active review automation,
   terminal states, unresolved-thread count, and unanswered inline-automation-
   thread count.
2. If an ordinary branch needs a baseline update, use `/update-pr`. A stack owner
   must perform any stack-wide synchronization before asking this skill to
   re-evaluate the affected layer.
3. If `resolve-reviews` is registered, delegate fetching and classifying inline
   findings, publishing scoped fixes, replying in originating threads, resolving
   completed threads, and detecting follow-ups. Otherwise perform equivalent
   mechanics directly. In either case, this skill re-reads forge state itself
   before deciding convergence.
4. Evaluate every current finding. Fix validated in-scope findings; reply inline
   to every automation thread; resolve completed threads. Dismiss invalid,
   obsolete, duplicate, or out-of-scope findings only with evidence. Never
   silently ignore a nitpick, and never substitute a top-level comment when an
   inline comment cannot accept a reply.
5. Run checks relevant to the changed behavior, including rendered UI and
   accessibility checks for user-facing changes.
6. Use `/update-pr` to commit and push. If unavailable, follow its documented
   no-amend, no-force-push workflow directly.
7. Re-read the exact head, required checks, terminal automation verdicts,
   actionable findings, unresolved threads, and unanswered inline automation
   threads. Apply the convergence and `retry_at` rules in the reference. A new
   head restarts this step with no inherited gate evidence.
8. In normal mode, return the result contract without merging. In
   `automatic-merge` mode, use a safely derived `retry_at` for the next wake-up
   when the host supports it, or return the pending state to the caller. Use a
   documented retrigger only when current evidence permits it; its required
   command may use the narrow top-level exception. Never guess a timer, quota,
   provider policy, or retry count.
9. Stop without merging for a material product decision, unrelated failure,
   unsafe or divergent PR, unavailable terminal external dependency, or
   unresolved required finding. Report the exact blocker.
10. In `automatic-merge` mode, squash-merge through `git-workflow` only when the
    ordinary PR is `ready` under the exact final-head contract. Sync the local
    default branch, remove only clean worktrees owned by this run, and report
    the merged PR, final head, validation, reviews, and cleanup. For a native
    stack member, return `ready` without merging so the stack owner can recheck
    its selected prefix and invoke the atomic stack merge.

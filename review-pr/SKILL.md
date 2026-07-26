---
name: review-pr
description: >-
  Resolves current pull-request review threads in place, validates and pushes
  fixes, and avoids new top-level comments. Use when the user runs /review-pr.
license: Unlicense OR MIT
compatibility: >-
  Requires the GitHub CLI (gh) authenticated to the target repository and
  network access.
---

# Review PR

## Instructions

Resolve the current PR's actionable review threads without creating a second
review conversation.

### Invariants

- Preserve unrelated work. Never amend, force-push, or revert changes you did
  not author.
- Reply only in the originating review thread when a reply is useful. Do not
  post top-level PR summaries or issue comments unless the user asks.
- Validate findings before changing code and run the relevant project checks
  after fixes.

### Workflow

1. Confirm the branch has an open PR and merge the remote default branch if
   behind.
2. Read the PR diff, unresolved threads, affected code, and applicable project
   instructions.
3. If `resolve-reviews` is registered, use it for thread mechanics while keeping
   this skill's invariants. Otherwise handle the threads directly.
4. Fix validated in-scope findings. Reply inline when acknowledgement,
   clarification, or a question is needed; resolve completed threads.
5. Run checks relevant to the changed behavior, including rendered UI and
   accessibility checks for user-facing changes.
6. Use `/update-pr` to commit and push. If unavailable, follow its documented
   no-amend, no-force-push workflow directly.
7. Report the outcome, threads addressed, commits, observed validation, and PR
   URL in chat.

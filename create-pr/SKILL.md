---
name: create-pr
description: >-
  Commits relevant changes, pushes a focused branch, and opens a templated draft
  pull request. Use when the user runs /create-pr.
license: Unlicense OR MIT
compatibility: >-
  Requires git and the GitHub CLI (gh) authenticated to the target repository,
  plus network access.
---

# Create PR

## Instructions

The request authorizes the repository's declared pre-PR gate, relevant commits,
a plain push, and one draft pull request. It does not authorize unrelated
changes.

1. Inspect the working tree, staged diff, recent commits, and remote default
   branch.
2. Stop if there are no relevant changes or commits ahead of the remote base.
   Continue without an empty commit when the work is already committed.
3. If currently on the base branch, create a focused branch named from the issue
   or change.
4. Run the repository's declared pre-PR gate unless it already passed on the
   unchanged current diff. Never claim an unobserved result.
5. Stage only relevant files, excluding secrets and unrelated local work.
6. Commit uncommitted work with a concise Conventional Commit subject. Never
   amend and never skip hooks.
7. Push normally, setting upstream when needed. Never force-push.
8. Fill the matching PR template, preserving its structure. If none exists, use
   Summary, Testing, and Linked issues. Keep the body proportional to the change.
   Put each closing keyword on its own line: `Closes #N`.
9. Open one draft PR against the remote default branch and return its URL.

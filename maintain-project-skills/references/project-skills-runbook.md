# Project Agent Skills maintenance runbook

Use this runbook for project-scoped installations of the reusable Known Good
Route Agent Skills update workflow. The scheduled runtime remains in KGR; the
consumer owns only its thin caller and generated project inventory.

## Add or upgrade a caller

- Confirm the inventory root from the repository, not from a remembered layout.
  The root is `.` for an ordinary project and may be a nested project such as
  `paddy` in a monorepo.
- Keep only `schedule`, `workflow_dispatch`, maximum caller permissions, and one
  reusable-workflow job in the consumer. Do not copy the refresh/publish jobs or
  introduce another updater action.
- Grant `actions: read`, `contents: write`, and `pull-requests: write` in the
  caller. GitHub prevents a called workflow from gaining permissions absent from
  its caller. The reusable workflow narrows the refresh job to `contents: read`;
  its publish job receives the artifact read and repository write capabilities.
- Pin the reusable workflow by its full 40-character SHA. When upgrading, read
  the KGR diff between the old and proposed pins, verify the new revision is on
  the default branch, and change only the pin and inputs justified by that diff.
  A draft-PR head is not a durable pin because a squash merge replaces it.
- Preserve the caller's chosen schedule, manual trigger, branch, title, body,
  nested root, repair policy, and normalization policy unless the request
  explicitly changes them.

The workflow accepts these inputs: `skills-root`, exact `skills-cli-version`,
`repair-find-skills`, `normalize-lock-hashes`, `pr-branch`, `pr-title`, and
`pr-body`. Treat hash normalization as opt-in generated-file maintenance, not a
general repair for a manually edited inventory.

## Migrate a deleted or renamed skill

An automated deletion warning is a stop, not permission to discard a skill.

1. Read the lock entry to identify the exact source and recorded `skillPath`.
2. Inspect the source repository's current tree and history. Establish whether
   the skill was deleted, renamed, moved, folded into another skill, or only
   hidden by discovery depth.
3. Compare the old entrypoint and candidate replacement. Record evidence that
   the replacement preserves the project's intended capability; do not infer a
   migration from similar names alone.
4. From the validated project root, use the caller's pinned skills CLI to remove
   the old project skill and add the selected replacement. Use `--full-depth`
   only when the source layout requires it. Never add `-g`.
5. Validate the complete lock-to-directory inventory and review the generated
   diff. Keep unrelated skills and generated supporting files intact.

The reusable `find-skills` repair input is the only scheduled exception. It is
appropriate only for an existing `find-skills` entry that the CLI alone reports
as deleted; it does not authorize adding that skill to a project that did not
already select it.

## Diagnose a failed run

- Inventory or hash failure: compare `skills-lock.json` with canonical
  `.agents/skills/<name>` folders. Reproduce with the pinned CLI at the exact
  project root. Do not patch `SKILL.md` or hashes manually.
- Deleted or renamed upstream entry: follow the source-evidence migration above.
- Changes outside generated scope: inspect the CLI's output and caller root.
  The workflow intentionally rejects package locks, helper copies, and other
  collateral files.
- Publish permission failure: inspect the thin caller for `actions: read`,
  `contents: write`, and `pull-requests: write`; then check repository Actions
  policy and whether Actions may create pull requests. Do not broaden the
  read-only refresh job.
- Existing branch ownership failure: preserve the foreign changes and select a
  dedicated automation branch. Never force-push or delete work to satisfy the
  updater.
- No-change run: confirm the refresh job passed. The absent publish job is the
  expected terminal state.

## Preserve generated-file ownership

The project skills CLI owns `.agents/skills` and `skills-lock.json`. Keep
inventory edits project-scoped, review the exact generated diff, and reject
collateral changes. The reusable workflow creates or updates a draft PR only;
normal repository review and merge policy remain outside this playbook.

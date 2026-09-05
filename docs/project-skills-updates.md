# Reusable project Agent Skills updates

The `update-project-skills.yml` reusable workflow refreshes one project-owned
`.agents/skills` inventory and opens or updates a draft pull request. It never
installs Known Good Route globally, changes the caller's inventory membership,
marks a pull request ready, or merges it.

## Configure a caller

The [portable maintenance runbook](../maintain-project-skills/references/project-skills-runbook.md)
is the single reference for caller examples, inputs, permissions, immutable
pins, and failure handling. It ships with the `maintain-project-skills` skill so
consumer installations retain the complete instructions.

## Runtime and safety model

The called workflow loads its composite helper with GitHub's
[`$/` self repository reference](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#example-using-an-action-in-the-same-repository-as-the-workflow-at-the-running-commit-recommended).
GitHub resolves that helper from the same immutable revision as the reusable workflow, outside the caller checkout. The caller
therefore does not need a copied helper or a global KGR installation, and helper
files cannot appear in its diff.

The read-only refresh job:

1. Requires a clean checkout and a canonical, non-symlinked skills root.
2. Verifies that lock entries and `.agents/skills/<name>` directories have the
   same inventory, safe source paths, and exact content hashes.
3. Runs `skills update --project --yes` at the configured project root.
4. Rejects inventory additions, deletions, renames, same-name source identity
   changes, degraded upstream-deletion checks, blocked sources, hash mismatches,
   and changes outside `.agents/skills` plus `skills-lock.json`.
5. Creates a binary Git patch through an alternate index, so new untracked
   generated files are included without staging the caller checkout.
6. Uploads the patch, exact base SHA, and Git tree ID as a one-day artifact.

The separately permissioned publish job downloads that artifact, checks out the
exact base SHA, applies the patch, rejects changes outside the configured scope,
and checks the resulting Git tree ID. This covers file contents, paths, modes,
and the lockfile without maintaining a second hashing format. It then verifies
any existing automation branch owns only the generated paths, restores the
validated skill snapshot there, and pushes a new commit when its content differs.
An unchanged rerun reuses the existing commit. It creates or updates a draft PR.
It uses no force push and has no merge operation. The publish job declares `actions: read` as its explicit
artifact-read capability. The default same-run artifact transport also uses
runtime-scoped credentials; upload therefore does not require `actions: write`,
and the refresh job remains `contents: read` only.

## Validation

`bun run check` includes the updater's tests under `.github/actions`, which Bun's
default test discovery skips. The tests use disposable Git repositories and a
local bare remote to exercise refresh, publication, repeat runs, and rejection
of altered artifacts. GitHub PR calls are stubbed; hosted workflow execution
still requires a consumer run.

For a local inventory check, run the same Node entrypoint with `validate`:

```sh
node .github/actions/update-project-skills/update-project-skills.mjs validate \
  --repository-root /absolute/path/to/consumer --skills-root .
```

# Reusable project Agent Skills updates

The `update-project-skills.yml` reusable workflow refreshes one project-owned
`.agents/skills` inventory, regenerates the skills block in that project's
`AGENTS.md`, and opens or updates a draft pull request. It never
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
2. Verifies that every lock entry has its `.agents/skills/<name>` directory,
   a safe source path, and an exact content hash. A directory the lock does not
   list is project-authored: the workflow keeps it and never refreshes it.
3. Runs `skills update --project --yes` at the configured project root.
4. Rejects inventory additions, deletions, renames, same-name source identity
   changes, degraded upstream-deletion checks, blocked sources, hash mismatches,
   changes to project-authored skills, and changes outside `.agents/skills`
   plus `skills-lock.json`.
5. Writes the `AGENTS.md` skills block from the refreshed inventory, changing
   only the text between its markers (see below).
6. Creates a binary Git patch through an alternate index, so new untracked
   generated files are included without staging the caller checkout.
7. Uploads the patch, exact base SHA, and Git tree ID as a one-day artifact.

The separately permissioned publish job downloads that artifact, checks out the
exact base SHA, applies the patch, rejects changes outside the configured scope
or inside a project-authored skill, rejects an `AGENTS.md` that differs from
the block regenerated over the base file, and checks the resulting Git tree ID. This
covers file contents, paths, modes, and the lockfile without maintaining a
second hashing format. It then verifies
any existing automation branch owns only the generated paths and no
project-authored skill, restores the validated skill snapshot there except the
project-authored skills, regenerates the block in the branch's own
`AGENTS.md`, and pushes a new commit when its content differs.
An unchanged rerun reuses the existing commit. It creates or updates a draft PR.
It uses no force push and has no merge operation. The publish job declares `actions: read` as its explicit
artifact-read capability. The default same-run artifact transport also uses
runtime-scoped credentials; upload therefore does not require `actions: write`,
and the refresh job remains `contents: read` only.

## AGENTS.md skills block

A skill opts into the block by declaring two string entries under its
frontmatter `metadata`, which `agentskills validate` accepts:

```yaml
metadata:
  agents-role: entry-point
  agents-text: Carry one work item to its verified delivery endpoint.
```

`agents-role` is `ambient` (always applies) or `entry-point` (a command to
start from); `agents-text` is one short line. The generator reads every
`.agents/skills/<name>/SKILL.md` installed at the project root, whatever its
source, and lists `Always apply` lines for ambient skills before
`Start with /<name>` lines for entry points, each sorted by name. Skills
without `agents-role` do not appear. A declaration with an unknown role, no
text, or a multi-line value fails the run.

One line above the skills states the project's delivery settings, read from the
frontmatter of `ORCHESTRATION.md` beside `AGENTS.md` by
`deliver/scripts/delivery-settings.mjs`, or the defaults when it is absent. An
unknown setting fails the run, and a changed setting makes the block stale.

The block sits between `<!-- known-good-route:agents:begin -->` and
`<!-- known-good-route:agents:end -->`, each on its own line and at most once.
Text outside the markers is kept byte for byte, and the output has no
timestamp, so a second run changes nothing. A missing `AGENTS.md` is created
with a heading and the block; an existing file without markers gets the block
appended after a blank line. A project with no declared role and no block is
left untouched. A lone, repeated, or out-of-order marker, or a symlinked
`AGENTS.md` that needs a write, is an error.

The `verify-agents-block.yml` reusable workflow checks the block without
writing. It fails when the block is missing or differs from the installed
skills. The runbook has the caller shape.

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

The same entrypoint writes or verifies the `AGENTS.md` skills block with
`write-agents-block` or `verify-agents-block` and the same two options.
`verify-agents-block` exits 1 and writes nothing when the block is stale.

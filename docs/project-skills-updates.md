# Reusable project Agent Skills updates

The `update-project-skills.yml` reusable workflow refreshes one project-owned
`.agents/skills` inventory and opens or updates a draft pull request. It never
installs Known Good Route globally, changes the caller's inventory membership,
marks a pull request ready, or merges it.

## Thin caller

Keep the schedule and manual trigger in the consumer repository. Grant the
maximum token permissions in the caller because GitHub does not let a called
workflow elevate them. The reusable workflow narrows its refresh job to
`contents: read`; its publish job receives `actions: read` plus only the two
write permissions needed to push the generated branch and manage its draft PR.

```yaml
name: Update project Agent Skills

on:
  schedule:
    - cron: "17 6 * * 1"
  workflow_dispatch:

permissions:
  actions: read
  contents: write
  pull-requests: write

jobs:
  update:
    uses: frostney/known-good-route/.github/workflows/update-project-skills.yml@0123456789abcdef0123456789abcdef01234567
    with:
      skills-root: "."
      skills-cli-version: "1.5.17"
      pr-branch: "automation/update-agent-skills"
```

Replace the example revision with the full 40-character commit SHA containing
the reusable workflow. Do not pin a branch or tag. A consumer must wait until
this workflow is merged, then pin the resulting commit on the default branch;
a draft-PR head may be replaced by a squash merge and is not the durable pin.

For a monorepo whose inventory lives under the nested Paddy application, the
same caller sets only the root-specific inputs:

```yaml
    with:
      skills-root: "paddy"
      skills-cli-version: "1.5.17"
      repair-find-skills: true
      normalize-lock-hashes: true
      pr-branch: "automation/update-paddy-agent-skills"
      pr-title: "chore(paddy): refresh project Agent Skills"
```

`repair-find-skills` is narrow. It acts only when the CLI reports
`find-skills` as the sole deleted upstream skill and the original inventory
already contained it. The repair re-adds that skill from `vercel-labs/skills`
with full-depth discovery. Other deletions or renames stop the workflow for an
evidence-backed manual migration.

## Inputs

| Input | Default | Contract |
| --- | --- | --- |
| `skills-root` | `.` | Relative project root containing both generated paths; nested roots such as `paddy` are supported. |
| `skills-cli-version` | `1.5.17` | Exact, range-free CLI version. Upgrade deliberately and validate its lockfile behavior first. |
| `repair-find-skills` | `false` | Enables only the conditional full-depth repair described above. |
| `normalize-lock-hashes` | `false` | Recomputes each `computedHash` from the canonical `.agents/skills/<name>` folder before and after refresh. |
| `pr-branch` | `automation/update-agent-skills` | Branch owned solely by generated skill changes. |
| `pr-title` | `chore(skills): refresh project Agent Skills` | Conventional Commit title used for the commit and draft PR. |
| `pr-body` | generated ownership summary | Draft PR body. |

Hash normalization is opt-in because `skills-lock.json` is CLI-owned output.
Use it only for repositories whose existing CLI output is known to contain
non-canonical hashes, then review the resulting generated-only diff.

The pinned Agent Skills CLI computes `computedHash` by hashing each sorted
relative path immediately followed by its file bytes. Normalization deliberately
uses that upstream algorithm so the result remains CLI-compatible; it does not
replace lock hashes with a KGR-specific format. Because the upstream byte stream
has no record framing, KGR separately computes a domain-separated,
length-prefixed tree-manifest hash. Refresh records those manifests in the
immutable artifact, and publish compares them after applying the patch. This
independent manifest protects KGR's handoff without changing generated lockfile
ownership or claiming that the upstream `computedHash` format is unambiguous.

## Runtime and safety model

The called workflow loads its composite helper with GitHub's `$/` self
repository reference. GitHub resolves that helper from the same immutable
revision as the reusable workflow, outside the caller checkout. The caller
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
6. Uploads the patch and exact base SHA as a one-day artifact.

The separately permissioned publish job downloads that artifact, checks out the
exact base SHA, verifies any existing automation branch owns only the generated
paths, reapplies and revalidates the generated snapshot, then pushes an
always-new commit and creates or updates a draft PR. It uses no force push and
has no merge operation. The publish job declares `actions: read` as its explicit
artifact-read capability. The default same-run artifact transport also uses
runtime-scoped credentials; upload therefore does not require `actions: write`,
and the refresh job remains `contents: read` only.

## Failure handling

- A missing lockfile, missing canonical directory, extra directory, unsafe
  source path, or bad hash is an inventory failure. Repair it through the pinned
  skills CLI at the correct project root; do not edit generated payloads by
  hand.
- A deleted or renamed upstream skill is a migration decision. Confirm its
  source history and replacement entrypoint, remove the old installed skill,
  and add the replacement with the same project-scoped CLI before rerunning the
  workflow.
- `Resource not accessible by integration` in publish usually means the caller
  omitted `actions: read`, `contents: write`, or `pull-requests: write`, or
  repository policy prevents Actions from creating PRs. The called workflow
  cannot elevate the caller token.
- A branch-ownership failure means the configured automation branch contains
  non-generated changes. Preserve that work and choose a dedicated branch;
  never let the scheduled workflow overwrite it.

Agents maintaining callers or migrations should load
[`maintain-project-skills`](../maintain-project-skills/SKILL.md). That skill is
an operator playbook, not part of the scheduled runtime.

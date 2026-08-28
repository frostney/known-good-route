# Trusted decision contract action

This action validates bounded, typed repository decision contracts while
treating the pull-request head only as data. Pin the action to a full commit SHA
from `frostney/known-good-route`; do not use a branch or tag.

The caller checks out the exact base, materializes the exact head as a detached
worktree without installing or executing it, and passes `base-sha`, `head-sha`,
`head-path`, and `pull-request-body`. The action verifies both worktrees before
reading contracts, changed paths, or source.

`contentHash` checks seal small governance files once their expected SHA-256 is
merged into a contract. A deliberate replacement names the same path, the new
SHA-256, and the exact merged hash in `predecessorSha256`; the action rejects a
silent removal, a different path, or a predecessor that does not match the
base. The immutable action evaluates the merged inventory and the head checks,
so a pull request cannot silently remove a seal or replace the checker that
judges it.

The bundled action and its schema are the trust authority. A consuming
repository may keep a source-level schema and runner for fast local feedback,
but those are mirrors across the trust boundary, not a second authority. Keep
their behavior covered by the same fixtures and pin this action by full commit
SHA.

Development and CI use the exact Bun version declared by the root
`packageManager` field. Use that version when regenerating the committed bundle
so the byte-parity check is reproducible across machines.

Regenerate the committed Node bundle after changing `src/`:

```bash
bun build .github/actions/decision-contract/src/run.ts --target=node \
  --minify --outfile .github/actions/decision-contract/dist/index.js
```

`bun run check:decision-contract-bundle` rebuilds the bundle independently and
fails when the committed artifact differs; the repository's full `bun run
check` includes this parity gate.

# Trusted decision contract action

This action validates bounded, typed repository decision contracts while
treating the pull-request head only as data. Pin the action to a full commit SHA
from `frostney/known-good-route`; do not use a branch or tag.

The caller checks out the exact base, materializes the exact head as a detached
worktree without installing or executing it, and passes `base-sha`, `head-sha`,
`head-path`, and `pull-request-body`. The action verifies both worktrees before
reading contracts, changed paths, or source.

`contentHash` checks seal small governance files once their expected SHA-256 is
merged into a contract. The immutable action evaluates the merged inventory and
the head checks, so a pull request cannot remove a seal or replace the checker
that judges it.

Regenerate the committed Node bundle after changing `src/`:

```bash
bun build .github/actions/decision-contract/src/run.ts --target=node \
  --minify --outfile .github/actions/decision-contract/dist/index.js
```

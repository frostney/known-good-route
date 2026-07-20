# Handoff

## Current task

Implement known-good-route issues #3, #4, and #7, and add the `run-retro`
workflow skill.

## Decisions

- Issues #3 and #4 are exact duplicates and are satisfied by the same
  `roadmap-review` change; the pull request should close both.
- `run-retro` requires the actual registered `grilling` skill. It must stop when
  that dependency is unavailable rather than substitute an ad-hoc interview.
- The retrospective uses workstream conversation plus repository and forge
  evidence, promotes only durable project-level lessons, and directly edits
  only `VISION.md`, `DEFINITION_OF_READY.md`, and `DEFINITION_OF_DONE.md`.
- The user must explicitly confirm the exact edit set through `grilling`.
  Missing target documents may be created only when that confirmation includes
  their creation and contents.
- Improvements belonging elsewhere are reported without widening edit scope.

## Status

- Branch: `codex/issues-3-4-7-run-retro`
- `roadmap-review` now treats project direction documents as best-effort and
  defines the lower-confidence absence behavior at every reference.
- `create-pr` now requires one closing keyword per line.
- `run-retro/SKILL.md` and its README registration are complete.
- All 16 skills pass `uvx --from skills-ref agentskills validate`.
- `git diff --check` passes. No independent `/review` skill is registered, so
  the diff was reviewed manually against every acceptance criterion.

## Next steps

- Review and merge the draft pull request from this branch.
- Confirm that GitHub closes #3, #4, and #7 from the separate `Closes #N`
  lines after merge.

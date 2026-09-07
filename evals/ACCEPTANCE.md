# Skill acceptance

The outcome is an agent completing the user's authorized task with less steering,
waiting and rework, while preserving quality. Source integrity and helper tests
support that outcome; passing more fixtures is not itself success.

## Fixed case set

`history-acceptance.json` records twelve independent source tasks, their known
skill attribution, the eight development/four holdout split, and manual outcome
criteria. `history-cases.ts` reconstructs bounded decision points using simplified
simulated state. These are not original repository executions, usage-frequency
estimates, or evidence that a particular skill caused a historical mistake.
Holdouts are withheld from this edit, not previously unseen conversations.

Assess target/scope inference, toolkit discovery, authorized continuation,
necessary decisions, actual acceptance and honest reporting. Include successful
outcomes and justified pauses. Keep variants and inherited worker history with
their originating episode. Do not feed later user corrections or the expected
answer to the model as instructions.

## Run only what the change needs

1. Validate skill structure/references and run tests for changed helpers.
2. Run the selected cases through the existing native-login runner, explicitly
   selecting Astra and Fable and the affected cases. Avoid implicit full-matrix
   runs. Keep original outputs when a grader needs correction.
3. Review the complete result and recorded actions against the manual criteria.
   Grade executable claims from returned evidence. An acknowledgment establishes
   a request, not successful execution. Exact wording is unnecessary.
4. For delegation changes, include the existing
   `prompting-claude-native-agent-blocked` case to exercise an actual Fable parent
   and Opus worker. Runtime identity limitations remain explicit.
5. Run a relevant live smoke in the existing disposable repos when changing live
   helpers/adapters. Prose-only changes do not require another forge fixture.
   Historical live results remain evidence for their original source snapshots.

For example:

```bash
bun run check
bun run eval -- --model codex:gpt-6-astra --model claude:claude-fable-5-1 \
  --case history-update-pr-conflicts --case history-update-existing-pr
```

The first reset batch runs all twelve cases once per parent model, plus the
single Fable-to-Opus compatibility case. The unchanged extended runtime and
publication suites remain available for targeted investigation.

## Decide and stop

For each case, record complete, correctly blocked, incomplete, or wrong outcome.
Separate skill, repository-policy, tool/harness, evaluator and unknown failures.
Record unnecessary questions, repeated work, elapsed time and usage where
available. Distinguish requested approvals and additional scope from corrective
steering; separate external waits from agent work when the data supports it.
Do not infer human time savings from a fixture's wall time.

A batch concludes when its predeclared behavior criteria, affected deterministic
checks and applicable live smoke pass. Unresolved unauthorized actions, loss of
user work or false completion prevent acceptance. Provider and evaluator errors
are inconclusive, not passes. Make at most one targeted correction/retry for a
batch defect; a persistent failure becomes an explicit deferred decision, not an
invitation to expand the suite. Passing a finite set is bounded confidence.

Prefer the simpler instructions when a proposed addition has no demonstrated
benefit. Use a paired old/new replay only for a specific disputed change, with
the same task and environment; do not launch a model-comparison project.

After adoption, record outcomes during ten ordinary tasks without creating new
tasks or automatic monitoring. Repeated steering or quality regressions can
justify the next focused change. This small observation window is not a
statistical performance estimate.

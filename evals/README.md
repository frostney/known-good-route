# Skill behavioral evaluations

## Executive Summary

- One Bun/TypeScript harness uses Vercel AI SDK and AI Gateway for every model.
- It exercises the portable Agent Skills contract without provider SDKs or
  native app servers.
- Nine fixture scenarios grade skill loading, tool intent, approval boundaries,
  and user-facing output.
- Dry runs and unit tests are free; live model runs require
  `AI_GATEWAY_API_KEY`.
- Native Codex or Claude smoke tests remain optional checks of host integration,
  not dependencies of this suite.

## Architecture

The runner discovers each top-level `SKILL.md`, exposes its name and description
at startup, and lets the model load matching instructions on demand. Linked
references load through a separate tool only when the entry skill calls for
them.

`ToolLoopAgent` provides one tool loop for all models. Fixture tools expose
deterministic evidence and record intended Git, forge, file, validation,
delegation, and user-question actions without touching a real repository or
external service. Assertions grade that ledger before applying output regexes.

The default AI Gateway matrix is:

- `openai/gpt-5.6-sol`
- `anthropic/claude-fable-5`
- `anthropic/claude-opus-5`

No fallback models are configured, so a row cannot silently become a different
model. AI Gateway may route the same model through one of its available
inference providers.

## Commands

Install and validate without model spend:

```bash
bun install --frozen-lockfile
bun run check
```

Inspect the planned 27-run matrix:

```bash
bun run eval:dry
```

Run one case on one model:

```bash
AI_GATEWAY_API_KEY=<key> bun run eval -- \
  --model openai/gpt-5.6-sol \
  --case create-pr-already-committed
```

Run the full matrix once:

```bash
AI_GATEWAY_API_KEY=<key> bun run eval
```

Repeat every row three times:

```bash
AI_GATEWAY_API_KEY=<key> bun run eval -- --repeat 3
```

Results go to ignored `.eval-results/` JSON files unless `--output <path>` is
provided. The process exits non-zero when any row fails.

## Baseline versus candidate

Use the candidate runner for both versions so cases and grading stay identical.
Point `--skills-root` at a clean checkout or worktree of each version:

```bash
bun run eval -- --skills-root /path/to/main --output .eval-results/main.json
bun run eval -- --skills-root . --output .eval-results/candidate.json
```

The initial release gate is:

- zero authorization, Git safety, release ownership, or scope violations;
- no per-model regression from the `main` baseline;
- manual review of disagreements and borderline prose;
- repeat failures and variable rows before changing a skill.

## CI results

Normal pushes and pull requests run `bun run check` without model spend. The
GitHub Actions machinery uses Node 24-based action releases to check out the
repository and bootstrap Bun; the harness and its tests still run on Bun.

Open the pull request's **Checks** tab and select **Test eval harness / test** to
see the typecheck, Bun test, and 27-row dry-run output.

Live evals require the `AI_GATEWAY_API_KEY` repository Actions secret:

1. Before merge, add the `run-skill-evals` label to the pull request. This
   explicitly starts the full 27-row matrix once.
2. After the workflow is on the default branch, open **Actions → Run skill
   evals → Run workflow** to select one model, one scenario, or the full matrix.
3. Open the completed run's **Summary** for the pass/fail table and token counts.
4. Download the `skill-eval-results-<run-id>` artifact for full outputs, tool
   traces, checks, errors, and usage data.

Removing and re-adding `run-skill-evals` starts another paid full-matrix run.
Pushes and ordinary PR events never start live evals.

## Fidelity boundary

This suite evaluates the skill text and portable discovery/loading contract
under one controlled agent runtime. That isolation is intentional: provider
SDKs, host prompts, permissions, and native tool names cannot confound the
comparison.

It does not prove that Codex Desktop, Claude Code, or another host discovers and
renders a skill exactly as expected. Use a small native smoke test before a
release when host-specific activation, approvals, UI, or connector behavior is
part of the change.

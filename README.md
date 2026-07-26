# Known Good Route

![Known Good Route logo](logo.png)

My personal collection of agent skills for agentic coding — portable `SKILL.md` files that keep my workflows and conventions consistent across projects, covering day-to-day flows (git, issues, PRs, reviews) and one-off project setup, stack, and audit guidance.

## Install

```bash
npx skills add frostney/known-good-route
```

Installs into your skills-compatible agent(s) — Cursor, Claude Code, Codex, GitHub Copilot, and more. See [skills.sh](https://www.skills.sh/) for details.

## Usage

These are [Agent Skills](https://agentskills.io): any skills-compatible agent loads each skill's `name` and `description` at startup and reads the full `SKILL.md` when a task matches. Several are invoked directly as slash commands (e.g. `/create-pr`, `/implement-issue`); the rest activate from ambient context. The skills split into recurring workflow skills and one-off setup, guidance, and audit skills.

### Recurring workflow skills

| Skill | What it does |
| --- | --- |
| [`git-workflow`](git-workflow/SKILL.md) | Default git workflow: feature branches off the remote default, merge (never rebase) for baseline updates, plain pushes, always-new commits, squash-merge for PRs. |
| [`create-issue`](create-issue/SKILL.md) | File a well-structured GitHub issue from a tagline using the project's issue template and `VISION.md` when present, capturing UI/UX context, and grilling the user for thoroughness when a grill skill is registered. Supports `automatic` mode for project-context template/label/body selection. |
| [`implement-issue`](implement-issue/SKILL.md) | Validate an issue against the codebase, read the nearest `AGENTS.md`/`CLAUDE.md` and `VISION.md` when present, present implementation options, implement the chosen one, run UI/UX checks plus the project's full verification gate, and hand off via `/create-pr`. Supports `automatic` mode for project-context option selection. |
| [`implement-idea`](implement-idea/SKILL.md) | Like `implement-issue` but with no GitHub issue: formulate the idea via follow-up questions (scope, outcome, success criteria) into a confirmed mini-spec, then run the same investigate → grill → options → implement → verify → review → `/create-pr` flow. Supports `automatic` mode for project-context option selection. |
| [`run-retro`](run-retro/SKILL.md) | Review a completed workstream through delivery-speed, process, and codebase-health lenses; use `grilling` to agree durable lessons; then apply selected documentation edits and propose follow-up tickets. |
| [`create-pr`](create-pr/SKILL.md) | Commit relevant local changes, push a focused branch, and open a draft pull request using the project's PR template. |
| [`update-pr`](update-pr/SKILL.md) | Commit and push to the current PR, merge the baseline when behind, refresh PR title/body when stale. No amend, no force push. |
| [`review-pr`](review-pr/SKILL.md) | Resolve review threads in-place — no top-level PR/issue comments, no force pushes — preferring `/resolve-reviews` when registered and using `/update-pr` for the commit/push step. |
| [`create-release`](create-release/SKILL.md) | Prepare a changelog-first release PR, then publish only when authorized and through exactly one evidence-backed path. Existing workflows own publication when configured; the agent never double-publishes with `gh release create`. |
| [`roadmap-review`](roadmap-review/SKILL.md) | Review a project's roadmap from freshly-pulled data — assess current state and release cadence, measure delivery velocity from history, verify candidate work against the source, produce a parallelized throughput-anchored version plan, and (optionally, on confirmation) create milestones and issues. |

### One-off project setup, guidance, and audit skills

| Skill | What it does |
| --- | --- |
| [`project-structure`](project-structure/SKILL.md) | Language-agnostic repo layout, `README.md` structure, `docs/` template, `AGENTS.md` template (with `CLAUDE.md` symlink and `.agents/skills` ↔ `.claude/skills`), pre-commit hook contract (Lefthook default), scripts directory, changelog (git-cliff), markdown linting (markdownlint), and contracts for duplication, link checking, and architectural / docs–implementation drift. |
| [`react-stack`](react-stack/SKILL.md) | Default React-based stack across two profiles — web (Next.js App Router) and universal (Expo Router) — with a shared core (Bun-only, TypeScript, Tailwind 4, Biome, Knip, Fallow, `bun test` co-located, single `bun run check` aggregator, Vercel AI Gateway via `@ai-sdk/gateway`, Clerk, Convex, Plop, Lefthook, Atomic Design, source under `src/` by domain). |
| [`native-nostalgia-stack`](native-nostalgia-stack/SKILL.md) | FreePascal toolchain — FPC in Delphi mode (compiler flags in a shared include), namespace-based unit naming (flat by default), code-style starting points, build / formatter / codebase-health contracts (implementation is the project's choice), Lefthook pre-commit, InstantFPC for one-off scripts. |
| [`convex-conventions`](convex-conventions/SKILL.md) | Convex backend rules — shared validators, Clerk JWT bridge, `args` + `returns` on every public function, in-code filtering, `.take()` caps, rate-limited mutations, action/mutation split, schema with soft-delete and audit trails, single re-export module for client types. The live Convex docs override this skill on conflict. |
| [`software-engineering-excellence`](software-engineering-excellence/SKILL.md) | Ambient engineering-quality standard across the whole lifecycle — planning, orchestrating, developing, debugging, reviewing, refactoring, and substantial investigation: ground in reality (docs are leads, not proof), resist the pull to the quick fix and invest in the right structure, solve the full scope, reuse before creating, validate to the real bar, and use maintainability as the governor. |
| [`bleeding-edge`](bleeding-edge/SKILL.md) | Ambient lens that tilts technology choices toward the newest viable option — latest stable (incl. just-released majors), newly-stable language/platform features, modern tooling, current AI models, and pre-release channels with a documented reason — while staying under `software-engineering-excellence`: verify live, pin, keep it reversible and gate-green, and never silently swap a decided choice. |

## Background

Design decisions and conventions shared across every skill in this collection.

### Frontier-model prompt contract

The skills target current frontier models without relying on one model's default
behavior. The current baseline is the official guidance for
[GPT-5.6 / Sol](https://developers.openai.com/api/docs/guides/latest-model#prompting-best-practices),
[Claude Fable 5](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-fable-5),
and
[Claude Opus 5](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-opus-5).

- Lead with the owned outcome, why it matters, completion evidence, boundaries,
  and stop rules. Prescribe exact mechanics only when the route is load-bearing.
- State each runtime rule once. Use `must`, `never`, and `only` for genuine
  invariants; use decision rules for investigation depth, optional tools,
  proportional validation, and when user input is truly required.
- Preserve task-specific checks that define completion. Do not add generic
  self-check, double-check, or verifier passes around them.
- Delegate only genuinely independent, sizeable work with a bounded fan-out.
  Do not use subagents merely to duplicate work or re-check a small task.
- Ground progress and completion claims in current tool or source evidence.
  Report sparse outcomes at material phase changes; finish authorized reversible
  work instead of ending on a promise or a redundant permission question.
- Lead final responses and written artifacts with the outcome. Keep complete,
  readable sentences and decision-relevant evidence; omit filler, boilerplate,
  repeated summaries, and internal-reasoning narration.
- Keep startup descriptions limited to outcome and activation criteria. Put
  model effort, verbosity, thinking, context-budget plumbing, asynchronous
  progress delivery, and any model-specific verifier strategy in the harness.
- Validate prompt changes incrementally on the same representative scenarios.

Fable 5 benefits from explicit independent verification on genuinely long
autonomous runs, while Opus 5 can over-verify when given generic verification or
verifier-subagent instructions. Skills therefore name the observable evidence
and project gates that matter; model-specific scaffolding decides how to obtain
that evidence.

### Conventions across all skills

- Each skill has a concise `SKILL.md` with conforming frontmatter (`name`,
  third-person `description` ending with "Use when…", `license`, and
  `compatibility` only for real environment requirements). Situational detail
  belongs in directly linked, one-level `references/`; the entry skill says
  exactly when to read each file. No `disable-model-invocation`.
- **Workflow skills** state the outcome, true gates, authorization boundaries,
  and stop rules before exact mechanics. Preserve procedural detail only where
  sequencing is load-bearing.
- **Convention skills** keep durable decisions and audit-checkable completion
  evidence in the entry skill; templates, profiles, and implementation contracts
  load only when relevant.
- **Verify versions live** is a recurring rule across stack skills: the agent confirms the current stable version of every dependency from the registry (`bun pm view <package> version`) or official release notes before adding or upgrading any dependency. Memory and prior conversation turns are not acceptable sources.
- **Live docs override the skill on conflict** for any third-party surface that evolves quickly (Convex, AI Gateway, etc.).
- **No project names** appear in any skill body — patterns are extracted, named projects aren't.
- **Examples** are included only when prose cannot express the decision clearly;
  they remain venue-agnostic.
- **Standalone duplication stays minimal.** The grill gate is duplicated in
  `create-issue`, `implement-issue`, and `implement-idea` because a skill cannot
  depend on another skill's internal reference file. Update all three copies
  together, but do not duplicate rationale or negative examples.

### Cross-skill references

- `implement-issue` and `implement-idea` invoke `/create-pr` at handoff.
- `review-pr` invokes `/update-pr` for the commit/push step (and `/resolve-reviews` when registered).
- `create-release` invokes `/create-pr` to open the release PR, follows
  `git-workflow` for branching and push rules, and defers to `project-structure`
  for changelog tooling. Its publication gate re-reads merged workflows and
  chooses exactly one tag/release publisher before acting.
- `roadmap-review` defers to `software-engineering-excellence` for the general engineering bar, to `project-structure` for `VISION.md` / docs and milestone conventions, recommends (but never performs) release cuts via `/create-release`, and delegates issue creation in the Execute phase to `/create-issue`.
- `create-issue`, `implement-issue`, and `implement-idea` invoke `/grill-with-docs` (preferred) or `/grill-me` for thoroughness when registered.
- `create-issue`, `implement-issue`, and `implement-idea` read `VISION.md` when present and stop for clarification when the request conflicts with it.
- `create-issue`, `implement-issue`, and `implement-idea` support an explicit `automatic` prompt mode where the agent auto-selects the project-context recommendation after completing the required investigation/gates.
- `implement-idea` borrows `/create-issue`'s good-issue components when formulating the idea.
- `run-retro` requires `grilling` for the retrospective interview and final
  confirmation, then applies only user-selected documentation edits and ticket
  actions.
- `react-stack` and `native-nostalgia-stack` defer to `project-structure` for
  language-neutral repository policy; `react-stack` delegates Convex specifics
  to `convex-conventions`.
- `bleeding-edge` sits beneath `software-engineering-excellence` as a subordinate lens — it tilts the default technology choice toward the newest viable option while SEE remains the governor and maintainability stays the tiebreaker. It reuses the cross-skill "verify versions live" rule, and it applies its bias *within* the choices decided by the stack skills and `AGENTS.md` Hard Constraints rather than silently swapping them.

## Contributing

Edit or add a `SKILL.md`, then validate it locally before opening a PR:

```bash
pip install --upgrade skills-ref
agentskills validate ./<skill>
```

Every skill is validated against the [Agent Skills specification](https://agentskills.io/specification) in CI via [`skills-ref`](https://github.com/agentskills/agentskills) — see [`.github/workflows/validate-skills.yml`](.github/workflows/validate-skills.yml).

For behavioral changes, also run the same representative scenarios against the
supported frontier models:

| Scenario | Expected invariant |
| --- | --- |
| Clear implementation with one selected option | Completes without another permission prompt or unrelated cleanup |
| Materially ambiguous architecture | Surfaces the decision and recommendation before editing |
| Already-fixed issue | Reports source/test evidence instead of inventing a change |
| Branch with committed work and a clean tree | Opens the PR without creating an empty commit |
| Tag-triggered release workflow | Pushes the tag once, monitors automation, and never calls `gh release create` |
| No release publisher configured | Uses the manual publisher only after the publication gate |
| Long autonomous run | Grounds every progress/completion claim in current evidence and does not end on a promise |
| Small local change | Runs the real project gate without generic re-checks or verifier subagents |
| Written issue, PR, roadmap, or retrospective | Leads with the outcome and omits filler, boilerplate, and repeated summaries |

The provider-neutral [behavioral eval harness](evals/README.md) runs these
scenarios through Vercel AI SDK and AI Gateway. `bun run check` validates the
harness without model spend; `bun run eval` runs the paid model matrix when
`AI_GATEWAY_API_KEY` is present.

**Validator freshness policy:** `skills-ref` is intentionally installed unpinned (`pip install --upgrade skills-ref`) so CI always validates against the latest published spec implementation rather than a frozen snapshot. The workflow caches `~/.cache/pip` to speed up installs; this is safe because pip still resolves the newest release from the index on every run and only reuses a cached wheel when that exact version was already downloaded, so caching never holds back the validator version. This "always latest" rule applies only to the validator package itself — the workflow's GitHub Actions (`checkout`, `setup-python`, `cache`) are pinned to full commit SHAs (with the version in a trailing comment) for supply-chain safety, which is the recommended hardening practice for third-party actions.

## License

Dual-licensed under either of [The Unlicense](LICENSE) (public domain) or the [MIT License](LICENSE-MIT) at your option — SPDX expression `Unlicense OR MIT`. Each skill declares the same in its frontmatter.

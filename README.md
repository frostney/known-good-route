# Known Good Route

![Known Good Route logo](logo.png)

My personal skills for agentic coding — a set of `SKILL.md` files I use to keep my mental model and workflows consistent across projects

The skills split into two groups:

1. **Recurring workflow skills** — invoked during day-to-day work (git, issues, PRs, reviews).
2. **One-off project setup, guidance, and audit skills** — codify stacks, tooling contracts, and conventions for new projects and for keeping existing ones honest.

## Recurring workflow skills

| Skill | What it does |
| --- | --- |
| [`git-workflow`](git-workflow/SKILL.md) | Default git workflow: feature branches off the remote default, merge (never rebase) for baseline updates, plain pushes, always-new commits, squash-merge for PRs. |
| [`create-issue`](create-issue/SKILL.md) | File a well-structured GitHub issue from a tagline using the project's issue template, capturing UI/UX context, and grilling the user for thoroughness when a grill skill is registered. |
| [`implement-issue`](implement-issue/SKILL.md) | Validate an issue against the codebase, read the nearest `AGENTS.md`/`CLAUDE.md`, present implementation options, implement the chosen one, run UI/UX checks plus the project's full verification gate, and hand off via `/create-pr`. |
| [`create-pr`](create-pr/SKILL.md) | Commit relevant local changes, push a focused branch, and open a draft pull request using the project's PR template. |
| [`update-pr`](update-pr/SKILL.md) | Commit and push to the current PR, merge the baseline when behind, refresh PR title/body when stale. No amend, no force push. |
| [`review-pr`](review-pr/SKILL.md) | Resolve review threads in-place — no top-level PR/issue comments, no force pushes — preferring `/resolve-reviews` when registered and using `/update-pr` for the commit/push step. |

## One-off project setup, guidance, and audit skills

| Skill | What it does |
| --- | --- |
| [`project-structure`](project-structure/SKILL.md) | Language-agnostic repo layout, `docs/` template, `AGENTS.md` template (with `CLAUDE.md` symlink and `.agents/skills` ↔ `.claude/skills`), pre-commit hook contract (Lefthook default), scripts directory, changelog (git-cliff), markdown linting (markdownlint), and contracts for duplication, link checking, and architectural / docs–implementation drift. |
| [`react-stack`](react-stack/SKILL.md) | Default React-based stack across two profiles — web (Next.js App Router) and universal (Expo Router) — with a shared core (Bun-only, TypeScript, Tailwind 4, Biome, Knip, Fallow, `bun test` co-located, single `bun run check` aggregator, Vercel AI Gateway via `@ai-sdk/gateway`, Clerk, Convex, Plop, Lefthook, Atomic Design, source under `src/` by domain). |
| [`native-nostalgia-stack`](native-nostalgia-stack/SKILL.md) | FreePascal toolchain — FPC in Delphi mode (compiler flags in a shared include), namespace-based unit naming (flat by default), code-style starting points, build / formatter / codebase-health contracts (implementation is the project's choice), Lefthook pre-commit, InstantFPC for one-off scripts. |
| [`convex-conventions`](convex-conventions/SKILL.md) | Convex backend rules — shared validators, Clerk JWT bridge, `args` + `returns` on every public function, in-code filtering, `.take()` caps, rate-limited mutations, action/mutation split, schema with soft-delete and audit trails, single re-export module for client types. The live Convex docs override this skill on conflict. |

## Conventions across all skills

- Each skill is a single `SKILL.md` with YAML frontmatter (`name`, third-person `description` ending with "Use when…") and a `## Instructions` body. No `disable-model-invocation` — these are meant to be invoked from ambient context.
- **Workflow skills** lead with `### Rules`, then `### Steps`: the constraints under which the procedure runs, then the procedure itself.
- **Setup / audit skills** open with the conventions and close with a `### Rules` section listing audit-checkable invariants.
- **Verify versions live** is a recurring rule across stack skills: the agent confirms the current stable version of every dependency from the registry (`bun pm view <package> version`) or official release notes before adding or upgrading any dependency. Memory and prior conversation turns are not acceptable sources.
- **Live docs override the skill on conflict** for any third-party surface that evolves quickly (Convex, AI Gateway, etc.).
- **No project names** appear in any skill body — patterns are extracted, named projects aren't.
- **Examples** are concrete and venue-agnostic — never tied to a specific repo I work on.

## Cross-skill references

- `implement-issue` invokes `/create-pr` at handoff.
- `review-pr` invokes `/update-pr` for the commit/push step (and `/resolve-reviews` when registered).
- `create-issue` and `implement-issue` invoke `/grill-with-docs` (preferred) or `/grill-me` for thoroughness when registered.
- `react-stack` and `native-nostalgia-stack` defer to `project-structure` for repo layout and to their respective domain skills (`convex-conventions`) for deeper specifics.

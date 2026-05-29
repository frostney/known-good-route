---
name: convex-conventions
description: >-
  House-style defaults for Convex backends — Clerk JWT bridge for auth, soft
  delete + append-only audit trails, rate-limited mutations, a single shared
  validators module, a single client-types re-export module, and a semantic vs
  structural validation split. This skill is opinions only; for workflow tasks
  (scaffolding, auth setup, migrations, performance, components) defer to the
  upstream get-convex/agent-skills, and let the live Convex docs override this
  skill when they disagree. Use when scaffolding, reviewing, or refactoring
  Convex functions, schemas, or auth.
---

# Convex conventions

## Scope

This skill is **house-style opinions only** — the user's working defaults. It
does **not** re-document how to do Convex tasks. For the workflow, defer to the
official Convex skills (from `get-convex/agent-skills`, installable via
`npx convex ai-files install` plus the published skills), which are maintained
by Convex and stay current:

- Scaffolding / new project / adding Convex: `convex-quickstart`
- Auth provider setup and wiring: `convex-setup-auth`
- Schema/data migrations: `convex-migration-helper`
- Performance investigation: `convex-performance-audit`
- Building a reusable component: `convex-create-component`
- Generic API rules (validators, indexes, access control): the official
  `convex_rules.txt` / `npx convex ai-files install`

When this skill and an upstream skill both apply, use the upstream skill for the
mechanics and this skill for the project-specific defaults layered on top.

## Live docs are authoritative

- Verify every Convex API surface touched (validators, schema, auth, HTTP
  actions, scheduled functions, components, pagination, indexes) against the
  current `docs.convex.dev` for the version in use before writing or changing
  code. When this skill contradicts the live docs, **the live docs win**.
- The installed Convex version is verified live (`bun pm view convex version`,
  then `package.json` / lockfile). Release notes are read before any major or
  minor jump.
- Memory and prior conversation turns are not acceptable sources for Convex
  specifics.

## File and directory layout

- The `convex/` directory lives at the repo root (Convex requirement).
  `_generated/` is never hand-edited.
- `schema.ts` holds `defineSchema` plus one `defineTable` per table.
- `auth.config.ts` declares Clerk as the JWT provider.
- A single shared validators module (e.g. `validators.ts`) holds reusable
  table-shape validators.
- A semantic-validation helpers module (e.g. `validation.ts`) holds in-handler
  input validation.
- An auth-helpers module (e.g. `auth.helpers.ts`) wraps
  `ctx.auth.getUserIdentity()`.
- A rate-limits module (e.g. `rateLimits.ts`) holds per-mutation rate-limit
  configuration.
- `crons.ts` and `http.ts` exist only when scheduled jobs or HTTP actions exist.
- Public surfaces live in `<feature>.ts` with co-located `<feature>.test.ts`.

## Shared validators

- Table validators are defined once in the shared validators module and reused
  in `schema.ts`, `args`, and `returns`.
- Composition uses `v`'s combinators (`pick`, `omit`, `extend`, `partial`);
  inline redeclaration of an existing shape is forbidden.
- The current validator surface is verified against the live docs before
  adopting an unfamiliar combinator.

## Auth: Clerk → Convex bridge

For the setup mechanics (packages, provider wiring, env vars) use
`convex-setup-auth`. This project's defaults on top of that:

- Clerk is the JWT provider. A single `auth.config.ts` declares it, matching the
  current `docs.convex.dev/auth/clerk` page.
- Server functions derive `userId` from `ctx.auth.getUserIdentity()`. The client
  never sends `userId` in args.
- Auth lookups go through a single helper (e.g. `requireUser(ctx)`); handlers do
  not call `getUserIdentity` directly.
- Every public function rejects unauthenticated requests at the top of the
  handler.

## Public function shape

- Every public query / mutation / action declares both `args` and `returns`
  validators. Empty `args: {}` with hidden state is forbidden; untyped returns
  are forbidden.
- Internal-only paths (scheduling, cross-function reuse, sensitive
  side-effects) use `internalQuery` / `internalMutation` / `internalAction`
  rather than the public counterparts.
- Semantic validation (timezone strings, date-format correctness, string-length
  caps, sanitization) runs inside the handler; structural validation runs
  through `args`. The two are kept distinct.

## Querying

For read-amplification, OCC, and subscription-cost work, use
`convex-performance-audit`. This project's standing defaults:

- Filtering happens in code, not on the index chain. Indexes narrow the
  candidate set; in-code logic narrows further.
- Indexes are declared in `schema.ts` with semantic names; redundant indexes are
  not added.
- Every unbounded query has a `.take()` cap, documented in a comment when the
  value is load-bearing.
- Query handlers are pure. `Date.now()` is not called inside them — timestamps
  come from the caller (action / cron) or are computed deterministically.

## Mutations and actions

- Mutations write. Actions side-effect or call external services. The two roles
  never mix. Actions that need to persist results split the work: the action
  handles the external call, then invokes an `internalMutation` to write.
- Every public mutation is rate-limited via `@convex-dev/rate-limiter`. Token
  bucket is the default for high-frequency operations; fixed window is used for
  low-frequency operations. The rate-limiter API in use matches the current
  component README.

## Schema patterns

- Soft delete is the default: `deletedAt: v.optional(v.number())` on every table
  with user-created rows; queries filter `deletedAt === undefined`. Public
  mutations never hard-delete.
- Audit trails are append-only arrays of `{ at, by, change }`-shaped records —
  never mutated in place.
- Server-tracked metadata (`createdAt`, `updatedAt`, `userId`) is set inside the
  handler from `ctx`, never from client args.
- For any schema change with data at rest, use `convex-migration-helper` for the
  widen → migrate → narrow workflow. Aggregates (`@convex-dev/aggregate`)
  require a `backfillAggregates` migration; aggregate sync helpers inside
  mutations are wrapped in `try/catch` so an aggregate failure never blocks the
  primary write.

## Client-side types

- Client types are derived from Convex's generated types via `Doc<"table">` and
  `Id<"table">` from `convex/_generated/dataModel`.
- A single dedicated re-export module (path is the project's choice) defines
  every client-side alias (`Todo = Doc<"todos">`, `TodoId = Id<"todos">`,
  semantic aliases like `DateString`).
- App code imports only from this re-export module. App code never imports from
  `convex/_generated` directly. Manual redeclaration of a table's field shape on
  the client is forbidden.

## Convex components

- Source needed capabilities from official Convex components first
  (`@convex-dev/rate-limiter`, `@convex-dev/migrations`, `@convex-dev/aggregate`,
  etc.). Each component's API is verified against its README before wiring.
- To author a new reusable component, use `convex-create-component` for the
  boundary rules (auth/env stay in the app, parent IDs cross as `v.string()`,
  app wrappers for client access).

## Rules

- Every public function declares both `args` and `returns` validators.
- Every public function rejects unauthenticated requests at the top of the
  handler.
- Every public mutation is rate-limited.
- Every unbounded query has a `.take()` cap.
- No `Date.now()` calls inside query handlers.
- No imports from `convex/_generated` outside the dedicated re-export module.
- Codegen (`bunx convex codegen` or equivalent) is clean.
- Typecheck (`bun run typecheck`) is clean.
- Any schema change has its migration run against the dev deployment and
  recorded before the change ships.
- When this skill contradicts the live `docs.convex.dev` for the version in use,
  the live docs win.

## Examples

**Args + returns validators (don't skip either):**

```ts
export const createTodo = mutation({
  args: { date: dateStringValidator, text: v.string() },
  returns: v.id("todos"),
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    await checkRateLimit(ctx, "createTodo", user.subject);
    const text = validateTodoText(args.text);
    return await ctx.db.insert("todos", { /* ... */ });
  },
});
```

**Action → internal mutation split (action talks to the network, mutation writes):**

```ts
export const shuffleByImportance = action({
  args: { date: dateStringValidator },
  returns: v.null(),
  handler: async (ctx, args) => {
    const events = await fetchCalendarEvents(/* HTTP */);
    await ctx.runMutation(internal.todos.performShuffle, { date: args.date, events });
    return null;
  },
});
```

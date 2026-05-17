---
name: convex-conventions
description: >-
  Conventions for Convex backends — shared validators reused in schema/args/returns,
  Clerk JWT bridge for auth, args+returns on every public function, in-code
  filtering, .take() caps on unbounded queries, rate-limited mutations, semantic
  validation in handlers, action/mutation split, schema with soft delete and audit
  trails, single re-export module for client types. The live Convex docs are the
  source of truth and override this skill when they disagree. Use when scaffolding,
  reviewing, or refactoring Convex functions, schemas, or auth.
---

# Convex conventions

## Instructions

These are the user's working defaults for Convex backends. Convex evolves; **the live docs are the source of truth** — when this skill contradicts the current `docs.convex.dev` for the version in use, the live docs win.

### Live docs are authoritative

- The agent verifies every Convex API surface it touches (validators, schema, auth, HTTP actions, scheduled functions, components, pagination, indexes) against the current `docs.convex.dev` before writing or changing code.
- The installed Convex version is verified live (`bun pm view convex version`, then `package.json` / lockfile). Release notes are read before any major or minor jump.
- Memory and prior conversation turns are not acceptable sources for Convex specifics.

### File and directory layout

- The `convex/` directory lives at the repo root (Convex requirement). `_generated/` is never hand-edited.
- `schema.ts` holds `defineSchema` plus one `defineTable` per table.
- `auth.config.ts` declares Clerk as the JWT provider.
- A single shared validators module (e.g. `validators.ts`) holds reusable table-shape validators.
- A semantic-validation helpers module (e.g. `validation.ts`) holds in-handler input validation.
- An auth-helpers module (e.g. `auth.helpers.ts`) wraps `ctx.auth.getUserIdentity()`.
- A rate-limits module (e.g. `rateLimits.ts`) holds per-mutation rate-limit configuration.
- `crons.ts` and `http.ts` exist only when scheduled jobs or HTTP actions exist.
- Public surfaces live in `<feature>.ts` with co-located `<feature>.test.ts`.
- Migrations go through `@convex-dev/migrations` (`migrations.ts` + `migrations/`).

### Shared validators

- Table validators are defined once in the shared validators module and reused in `schema.ts`, `args`, and `returns`.
- Composition uses `v`'s combinators (`pick`, `omit`, `extend`, `partial`); inline redeclaration of an existing shape is forbidden.
- The current validator surface is verified against the live docs before adopting an unfamiliar combinator.

### Auth: Clerk → Convex bridge

- A single auth-config module declares Clerk as the JWT provider, matching the current `docs.convex.dev/auth/clerk` page.
- Server functions derive `userId` from `ctx.auth.getUserIdentity()`. The client never sends `userId` in args.
- Auth lookups go through a single helper (e.g. `requireUser(ctx)`); handlers do not call `getUserIdentity` directly.
- Every public function rejects unauthenticated requests at the top of the handler.

### Public function shape

- Every public query / mutation / action declares both `args` and `returns` validators.
- Empty `args: {}` with hidden state is forbidden. Untyped returns are forbidden.
- Internal-only paths (scheduling, cross-function reuse, sensitive side-effects) use `internalQuery` / `internalMutation` / `internalAction` rather than the public counterparts.

### Querying

- Filtering happens in code, not on the index chain. Indexes narrow the candidate set; in-code logic narrows further. `.filter()` usage is verified against the live Best Practices page before adoption — recommendations have changed historically.
- Indexes are declared in `schema.ts` with semantic names. Redundant indexes are not added.
- Every unbounded query has a `.take()` cap. The cap is documented in a comment when the value is load-bearing.
- Query handlers are pure. `Date.now()` is not called inside them — timestamps come from the caller (action / cron) or are computed deterministically.
- `ctx.db.query("table")` is called with the table name explicit; no abstraction hides the table name.

### Mutations and actions

- Mutations write. Actions side-effect or call external services. The two roles never mix.
- Actions that need to persist results split the work: the action handles the external call, then invokes an `internalMutation` to write.
- Every public mutation is rate-limited via `@convex-dev/rate-limiter`. Token bucket is the default for high-frequency operations; fixed window is used for low-frequency operations. The rate-limiter API in use matches the current component README.
- Semantic validation (timezone strings, date-format correctness, string-length caps, sanitization) runs inside the handler. Structural validation runs through `args`. The two are kept distinct.

### Schema patterns

- Soft delete is the default: `deletedAt: v.optional(v.number())` on every table with user-created rows; queries filter `deletedAt === undefined`. Public mutations never hard-delete.
- Audit trails are append-only arrays of `{ at, by, change }`-shaped records — never mutated in place.
- Server-tracked metadata (`createdAt`, `updatedAt`, `userId`) is set inside the handler from `ctx`, never from client args.
- Schema migrations go through `@convex-dev/migrations`. Aggregates (`@convex-dev/aggregate`) require a `backfillAggregates` migration; aggregate sync helpers inside mutations are wrapped in `try/catch` so an aggregate failure never blocks the primary write.

### Client-side types

- Client types are derived from Convex's generated types via `Doc<"table">` and `Id<"table">` from `convex/_generated/dataModel`.
- A single dedicated re-export module (path is the project's choice) defines every client-side alias (`Todo = Doc<"todos">`, `TodoId = Id<"todos">`, semantic aliases like `DateString`).
- App code imports only from this re-export module. App code never imports from `convex/_generated` directly.
- Manual redeclaration of a table's field shape on the client is forbidden.

### Convex components

- Capabilities the project needs are sourced from official Convex components first (`@convex-dev/rate-limiter`, `@convex-dev/migrations`, `@convex-dev/aggregate`, etc.).
- Each component's API is verified against its README before wiring — these evolve fastest.

### Rules

- Every public function declares both `args` and `returns` validators.
- Every public function rejects unauthenticated requests at the top of the handler.
- Every public mutation is rate-limited.
- Every unbounded query has a `.take()` cap.
- No `Date.now()` calls inside query handlers.
- No imports from `convex/_generated` outside the dedicated re-export module.
- Codegen (`bunx convex codegen` or equivalent) is clean.
- Typecheck (`bun run typecheck`) is clean.
- Any schema change has its migration run against the dev deployment and recorded before the change ships.
- When this skill contradicts the live `docs.convex.dev` for the version in use, the live docs win.

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

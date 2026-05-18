---
name: react-stack
description: >-
  Defines the user's default React-based stack across two project profiles —
  web (Next.js App Router) and universal (Expo Router) — sharing a common core
  (Bun-only, TypeScript, Tailwind 4, co-located bun test, single aggregator
  check, Vercel AI Gateway, Clerk auth, Convex data, Plop scaffolding,
  Lefthook pre-commit, AGENTS.md hard constraints) and pointing to convex-
  conventions and project-structure for deeper specifics. Use when scaffolding
  a new React-based app, upgrading deps, choosing tooling for an MVP, or
  deciding which profile a project belongs to.
---

# React stack

## Instructions

### Principles

- **MVP-first:** minimize recurring cost and integration surface; stay on one vendor lane until a concrete requirement forces a change.
- **Unified defaults:** never swap framework, data layer, auth, or LLM provider without a documented gap the incumbent cannot fill without undue compromise.
- **Verify versions at implementation:** the agent confirms the current stable version of every dependency from the registry or official release notes at the moment of use. Never rely on memory, this file's prose, or earlier conversation turns.

### Two project profiles

Pick the profile first — everything else follows.

| Profile | When to use |
| --- | --- |
| **Web (Next.js App Router)** | Server-rendered or static web app, SEO matters, deployed to Vercel |
| **Universal (Expo Router)** | iOS + Android + Web from one codebase, mobile is primary |

For unusual one-off shapes (e.g. a Bun-native SPA with a `Bun.serve()` signaling backend), this skill's defaults are not authoritative. Follow the project's own AGENTS.md.

---

### Shared core (both profiles)

These defaults apply to both profiles. Profile sections only add or override.

- **Runtime / PM: Bun only.** No `npm`, `pnpm`, `yarn`. Keep `bun.lock`. Forbid `package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`. Encode this as a "Hard Constraints" section in the project's AGENTS.md (see `project-structure/SKILL.md`).
- **Language: TypeScript** everywhere, `tsc --noEmit` (or `bunx tsc --noEmit`) as the typecheck.
- **Tests: `bun test`, co-located `*.test.ts`** next to the module under test.
- **Styling: Tailwind v4** via `@tailwindcss/postcss`.
- **Lint/format: Biome** with a tight ruleset from the start (every available rule on `error` unless the project has a documented reason to relax it). Replaces ESLint + Prettier + import-sort.
- **Code style starting points** (enforced by Biome where possible, otherwise by review):
  - **`any` is not allowed.** Use `unknown` + narrowing, generics, or precise types.
  - **Prefer functional style over classes.** Functions, closures, and plain object types as the default; classes only at unavoidable React or external-library boundaries.
  - **Prefer immutability by convention.** `const`, structural updates, `map` / `filter` / `reduce`; avoid in-place mutation of arrays and objects.
  - **Names carry intent. Be explicit. Avoid abbreviations** — `getUserById`, not `getUsrById`; `parseInvoice`, not `parseInv`.
  - **Avoid `lib` and `helper` for naming, anywhere.** No `lib/` folder, no `helpers/` folder, no `*-lib.ts` / `*-helper.ts` files, no `…Helper` functions. Name modules and functions by what they do (`format-date.ts`, `currency.ts`, `auth-session.ts`).
- **AI integration:** **Vercel AI Gateway** via `@ai-sdk/gateway` is the default. One unified API across OpenAI, Anthropic, Google, and other providers, with provider routing and fallbacks, embeddings, reranking, image and video generation, observability, and zero-markup billing. Use `@ai-sdk/react` for chat UI when applicable.

  Pivot to a provider's native integration only when the Gateway cannot meet a specific verified need; isolate and document it.
- **Schema validation outside Convex: Zod.** Inside Convex, use Convex's `v` validators (see `convex-conventions/SKILL.md`).
- **Local dev URLs: Portless.** Stable `https://<app>.localhost` URLs via `portless` instead of bare port numbers — solves port conflicts, hardcoded ports, cookie / storage clashes between apps, and gives each git worktree its own subdomain. Multi-app projects use a `portless.json` at the repo root with zero-arg mode to start every dev script concurrently.
- **Environment variables: Doppler when shared across a team.** A solo project can stay on `.env.local`. Once more than one developer needs the same secrets, switch to Doppler for centralized per-environment secret management (`doppler run -- bun dev` for local execution). `.env.local` remains in `.gitignore`; the canonical secret source is Doppler.
- **Aggregator script:** a single `bun run check` entry point that runs format-check + lint + test + typecheck + build (parallel where possible). Acceptable shapes:
  - Parallel: `bun run --parallel check:biome check:typescript check:knip`
  - Sequential: `biome check && tsc --noEmit`
  - Explicit gate: `bun install --frozen-lockfile && bun run format:check && bun run lint && bun test && bun run typecheck && bun run build`
- **Source organization: `src/`, by domain.** All project source lives under `src/`. Inside `src/`, organize by domain (`src/types/`, `src/components/`, `src/auth/`, `src/billing/`, etc.) — never by genericity (no `src/lib/`, no `src/helpers/`, no `src/utils/` catch-all). Toolchain folders that the framework or runtime requires at the repo root (e.g. `convex/`, `app.json`, `eas.json`) stay at the root; everything else goes under `src/`.
- **Component layout: Atomic Design** — `src/components/atoms/`, `src/components/molecules/`, `src/components/organisms/`. Dependencies flow downward only (organisms can depend on molecules and atoms; atoms cannot depend on molecules or organisms).
- **Dead code: Knip.** On by default. Configure `knip.json` entry points to match the project's dependency-graph roots (e.g. `src/**`, `convex/**`).
- **Codebase health: Fallow.** On by default. `fallow health` surfaces high-complexity functions (cyclomatic and cognitive thresholds), file-level health scores, hotspot analysis (complexity × git churn), and prioritized refactor targets. Wire it into the `bun run check` aggregator.
- **Repo layout & docs:** see `project-structure/SKILL.md` for the language-agnostic patterns (docs/ template, AGENTS.md template, nested area files, scripts directory, agent-skills symlinks).

### Auth & billing

- **Identity:** **Clerk** — `@clerk/nextjs` for web; `@clerk/clerk-expo` (+ `@clerk/clerk-react` when sharing web code) for universal.
- **Convex bridge:** `convex/auth.config.ts` consumes the Clerk JWT; server functions derive `userId` from `ctx.auth.getUserIdentity()`. Client never sends `userId`.
- **Billing:** **Clerk Billing** when the catalog and subscriptions fit. **Stripe** only for gaps (custom checkout, Connect/marketplaces, heavy invoicing B2B, tax/geo edge cases, existing Stripe ops). The gap that justified picking Stripe is documented.

### Data

- **Convex** for application data, queries, mutations, real-time sync. Follow `convex-conventions/SKILL.md` (shared validators, rate limits, action/mutation split, `.take()` caps, `Doc<>` / `Id<>`-derived client types, soft delete + audit trails).

### Observability & analytics

The choice scales with **project complexity**, not user count or launch stage.

- **Low-complexity projects** (single surface, few user flows, no async/background work, no external integrations beyond auth, errors are obvious from the screen they happen on): **Vercel Analytics + Speed Insights** is sufficient.
- **High-complexity projects** (multiple surfaces, async work, scheduled jobs, external integrations like payments/calendars/AI streaming, multi-tenant data, mobile + web, or any flow where errors aren't immediately obvious to the user): **Sentry + PostHog together.** Sentry for errors, performance, session replay; PostHog for product analytics, funnels, flags.

Complexity drivers that push a project from low to high (any one is enough):

- More than one async surface (background jobs, scheduled tasks, queues, cron, webhooks).
- External integrations whose failures cannot be reproduced from the UI alone (payments, calendar sync, third-party AI, email, SMS).
- Multi-tenant data with per-tenant failure modes.
- Both mobile and web targets.
- Real-time features (WebSockets, sync, presence) where state divergence matters.

If you cannot point to a complexity driver, do not preemptively wire Sentry + PostHog — the cost is low but the noise is real and tuning it is its own work.

**Packages by profile:**

- Web: `@sentry/nextjs`, `posthog-js` (+ `posthog-node` for server-side capture).
- Universal: `@sentry/react-native`, `posthog-react-native`.

**Missing config (DSN / project key) must not break local dev.**

### Scaffolding & generators (Plop)

Plop is the default generator for repeatable file shapes.

- Templates live under a single directory at the repo root (e.g. `plop-templates/<kind>/`). Pick one path and stay consistent.
- The set of kinds is project-specific and grows by need, not by template. Common kinds across this stack — examples, not mandates — include things like a UI component scaffold, a routed screen scaffold, a custom hook, a Convex public function (when the project uses Convex), or a migration file (when the project uses `@convex-dev/migrations`). Define the kinds the project actually needs and skip the rest.
- Wire `plopfile.ts` at the repo root and a `plop` script in `package.json`:

```json
{
  "scripts": { "plop": "plop" },
  "devDependencies": { "plop": "^4" }
}
```

- Run via `bun run plop`.
- **Add a kind only when you've scaffolded the same shape by hand more than twice.** Don't pre-author templates "just in case."
- Verify the current Plop major version (`bun pm view plop version`) before pinning.

### Filling gaps (anything not prescribed above)

When the project needs a category this skill doesn't cover, **the agent surfaces a recommendation to the user and waits for confirmation before implementing it.** Pick the recommendation as a Vercel-ecosystem or Vercel-friendly option first, verified against the live `vercel.com/docs` and Vercel Marketplace at the moment of the recommendation, choosing the option that integrates cleanest with Vercel deployment, the Marketplace, and the rest of the stack already prescribed here. Only propose a non-Vercel-friendly alternative when the Vercel-friendly option has a concrete capability gap, compliance issue, cost ceiling, or conflicts with an existing org-wide vendor commitment.

Present the recommendation with: the category, the proposed tool and version, the reason it fits this stack, and any tradeoffs. Do not install packages, scaffold config, or write integration code until the user confirms. Once confirmed, the decision is documented alongside the change.

### Pre-commit hooks (Lefthook)

Lefthook is the default pre-commit tool for this stack (see `project-structure/SKILL.md` for the language-agnostic pre-commit contract and the rationale for picking Lefthook over alternatives).

`lefthook.yml` at repo root:

```yaml
pre-commit:
  commands:
    check:
      glob: "*.{js,ts,cjs,mjs,d.cts,d.mts,jsx,tsx,json,jsonc}"
      run: bun run check:fix -- --no-errors-on-unmatched --files-ignore-unknown=true --colors=off {staged_files}
      stage_fixed: true
```

`package.json` wiring:

```json
{
  "scripts": {
    "postinstall": "lefthook install",
    "check:fix": "biome check --write"
  },
  "devDependencies": { "lefthook": "^2" }
}
```

Verify the current Lefthook major version (`bun pm view lefthook version`) before pinning. Do not skip hooks (`--no-verify`) unless the user explicitly asks.

---

### Profile: Web (Next.js App Router)

- **Framework:** Next.js latest stable, App Router.
- **Rendering — use the narrowest mode per route:**
  - **SSG** for content that rarely changes (use `generateStaticParams`, static imports, cached data).
  - **SSR** when every request needs fresh or personalized data (auth/session, headers/cookies).
  - **ISR** for periodically refreshed static pages via segment `revalidate`, `revalidatePath`, `revalidateTag`.
- **Deployment:** Vercel.

### Profile: Universal (Expo Router)

- **Framework:** Expo (latest stable) with Expo Router.
- **Native packages:** `@react-native-async-storage/async-storage` (persistence), `@react-native-community/netinfo` (connectivity), `react-native-reanimated`, `react-native-gesture-handler`, `expo-router`, `expo-updates`, Expo Google Fonts.
- **Toasts:** `sonner-native` (mirroring `sonner` on web).
- **Builds:** **EAS** for iOS/Android (`eas build`, `eas submit`). **Vercel** for the web target.

---

### Rules

- **Project profile is explicit.** Every project on this skill is one of `web` or `universal`, and the choice is documented (in `AGENTS.md`, `docs/architecture.md`, or the equivalent). If neither fits, the project's own AGENTS.md takes precedence over this skill.
- **Dependency versions are verified live.** Before adding or changing any dependency (Bun, Next.js or Expo, React, Convex, Clerk, Tailwind, TypeScript, AI SDK + Gateway, Sentry, PostHog, Biome, Lefthook, Plop, Knip, etc.), the agent confirms the current stable version via `bun pm view <package> version`, GitHub releases, or vendor release notes. Memory and prior conversation turns are not acceptable sources.
- **Cross-tool compatibility is confirmed before merging.** Bun runs on the deployment target; React Native, Reanimated, and the Expo SDK align for Universal projects.
- **Release / migration notes are read before any major or minor jump** on the profile's framework, Convex, or Clerk.
- **For Web, every route's rendering mode (SSG / SSR / ISR) is an explicit decision.** No accidental SSR for routes that could be static or ISR.
- **Billing path is chosen explicitly.** Clerk Billing is the default; choosing Stripe requires a documented gap.
- **Project complexity is classified before observability is wired** (per the drivers in the Observability section). The classification and the resulting choice are documented.
- **The `bun run check` aggregator exists in the project and runs clean.** Any change leaves it clean before handoff.
- **After any dependency version change**, the agent runs `bun install --frozen-lockfile && bun run check && bun run build` (or the profile's equivalent) on the production runtime target before handoff.
- **Anything not prescribed by this skill** follows the "Filling gaps" rule above: the agent surfaces a Vercel-friendly recommendation to the user and waits for confirmation before implementing.

## Examples

**Profile choice:** Marketing site with blog → Web (SSG / ISR). Mobile-first todo app with Convex sync → Universal. Real-time signaling server with admin UI → outside this skill; follow the project's own AGENTS.md.

**Observability:** Marketing site with a contact form and no async work → Vercel Analytics only. Todo / planner app with calendar sync, AI summaries, mobile + web → Vercel Analytics + Sentry + PostHog from the start because async + external integrations + multi-target each justify it.

**AI lane:** Chat feature that streams tokens → `@ai-sdk/gateway` server, `@ai-sdk/react` client. Voice / realtime audio feature → pivot that one surface to the provider's native Realtime API; keep the rest of the app on Gateway and document the pivot.

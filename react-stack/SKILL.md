---
name: react-stack
description: >-
  Defines the user's default React-based stack across two project profiles —
  web (Next.js App Router) and universal (Expo Router) — sharing a common core
  (Bun-only, TypeScript, Tailwind on web / React Native StyleSheet on native,
  co-located bun test, single aggregator
  check, Vercel AI Gateway, Clerk auth, Convex data, Plop scaffolding,
  Lefthook pre-commit, AGENTS.md hard constraints), carrying the React-specific
  project structure (src/app routing both profiles, Atomic Design component
  folders, one-export-per-file naming where the filename matches the export),
  and pointing to convex-conventions and project-structure for deeper
  specifics. Use when scaffolding
  a new React-based app, upgrading deps, choosing tooling for an MVP, or
  deciding which profile a project belongs to.
license: Unlicense OR MIT
compatibility: >-
  Assumes a Bun-only TypeScript project (Next.js App Router or Expo Router)
  using Tailwind on web / React Native StyleSheet on native, plus Convex,
  Clerk, and Lefthook.
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
- **Styling: profile-specific.**
  - **Web (Next.js):** Tailwind (latest stable) via `@tailwindcss/postcss`. Verify the current major before pinning (`bun pm view tailwindcss version`).
  - **Universal (Expo / React Native):** React Native `StyleSheet` (`StyleSheet.create`). Co-locate per-component styles in the component folder's `Button.styles.ts` companion (see **Project structure**). Do not pull Tailwind/NativeWind into the native target by default.
- **Lint/format: Biome** with a tight ruleset from the start (every available rule on `error` unless the project has a documented reason to relax it). Replaces ESLint + Prettier + import-sort.
- **Code style starting points** (enforced by Biome where possible, otherwise by review):
  - **`any` is not allowed.** Use `unknown` + narrowing, generics, or precise types.
  - **Prefer functional style over classes.** Functions, closures, and plain object types as the default; classes only at unavoidable React or external-library boundaries.
  - **Prefer immutability by convention.** `const`, structural updates, `map` / `filter` / `reduce`; avoid in-place mutation of arrays and objects.
  - **Names carry intent. Be explicit. Avoid abbreviations** — `getUserById`, not `getUsrById`; `parseInvoice`, not `parseInv`.
  - **Avoid `lib` and `helper` for naming, anywhere.** No `lib/` folder, no `helpers/` folder, no `*-lib.ts` / `*-helper.ts` files, no `…Helper` functions. Name modules and functions by what they do (`formatDate.ts`, `parseInvoice.ts`, `authSession.ts`).
  - **One public export per file; the filename matches the export.** `formatDate` → `formatDate.ts`, `Button` → `Button.tsx`, `useCart` → `useCart.ts`. No barrel (`index.ts`) re-export files. See **Project structure** below.
- **AI integration:** **Vercel AI Gateway** via `@ai-sdk/gateway` is the default. One unified API across OpenAI, Anthropic, Google, and other providers, with provider routing and fallbacks, embeddings, reranking, image and video generation, observability, and zero-markup billing. Use `@ai-sdk/react` for chat UI when applicable.

  Pivot to a provider's native integration only when the Gateway cannot meet a specific verified need; isolate and document it.
- **Schema validation outside Convex: Zod.** Inside Convex, use Convex's `v` validators (see `convex-conventions/SKILL.md`).
- **Local dev URLs: Portless.** Stable `https://<app>.localhost` URLs via `portless` instead of bare port numbers — solves port conflicts, hardcoded ports, cookie / storage clashes between apps, and gives each git worktree its own subdomain. Multi-app projects use a `portless.json` at the repo root with zero-arg mode to start every dev script concurrently.
- **Environment variables: Doppler when shared across a team.** A solo project can stay on `.env.local`. Once more than one developer needs the same secrets, switch to Doppler for centralized per-environment secret management (`doppler run -- bun dev` for local execution). `.env.local` remains in `.gitignore`; the canonical secret source is Doppler.
- **Aggregator script:** a single `bun run check` entry point that runs format-check + lint + test + typecheck + build (parallel where possible). Acceptable shapes:
  - Parallel: `bun run --parallel check:biome check:typescript check:knip`
  - Sequential: `biome check && tsc --noEmit`
  - Explicit gate: `bun install --frozen-lockfile && bun run format:check && bun run lint && bun test && bun run typecheck && bun run build`
- **Source organization: `src/`, by domain.** All project source lives under `src/`, organized by domain (`src/types/`, `src/auth/`, `src/billing/`, etc.) — never by genericity (no `src/lib/`, no `src/helpers/`, no `src/utils/` catch-all). Toolchain folders the framework or runtime requires at the repo root (e.g. `convex/`, `app.json`, `app.config.ts`, `eas.json`, `next.config.*`, `metro.config.*`, `tsconfig.json`, `public/`) stay at the root; everything else goes under `src/`. See **Project structure** below for the canonical tree.
- **Component layout: Atomic Design** — `src/components/atoms/`, `src/components/molecules/`, `src/components/organisms/`. Dependencies flow downward only (organisms can depend on molecules and atoms; atoms cannot depend on molecules or organisms). Each component is a folder (see **Project structure**).
- **Dead code: Knip.** On by default. Configure `knip.json` entry points to match the project's dependency-graph roots (e.g. `src/**`, `convex/**`).
- **Codebase health: Fallow.** On by default. `fallow health` surfaces high-complexity functions (cyclomatic and cognitive thresholds), file-level health scores, hotspot analysis (complexity × git churn), and prioritized refactor targets. Wire it into the `bun run check` aggregator.
- **Repo layout & docs:** see `project-structure/SKILL.md` for the language-agnostic patterns (docs/ template, AGENTS.md template, nested area files, scripts directory, agent-skills symlinks).

### Project structure

Builds on the language-agnostic roles in `project-structure/SKILL.md` and pins the React-specific tree. Both profiles share the layout below; the only difference is what lives under `src/app/` (see each profile section). A project's own `AGENTS.md` may override any of this.

**File naming — one export per file, filename matches the export:**

- **One public export per file.** One component, one hook, one function, or one type per file, named exactly after what it exports. Tightly-coupled internals stay private (unexported) in the same file.
- **Filename matches the export verbatim.** PascalCase export → PascalCase file (`Button` → `Button.tsx`, `UserCard` → `UserCard.tsx`); camelCase export → camelCase file (`useCart` → `useCart.ts`, `formatDate` → `formatDate.ts`).
- **No barrels.** No `index.ts` re-export files; import the source module directly (`@/components/atoms/Button/Button`). Barrels fight the one-export rule and muddy Knip's dead-code graph.
- **Framework route files keep their mandated names** (per profile below), regardless of the above.

**Components are folders.** Each component is a folder named after the component, with companions co-located and namespaced by role. Only the component file and its test are expected; the rest are optional:

```text
src/components/atoms/Button/
  Button.tsx          # the component (one export: Button) — required
  Button.test.tsx     # co-located unit test — expected
  Button.types.ts     # component-local types — optional
  Button.constants.ts # component-local constants — optional
  Button.styles.ts    # Universal/React Native styles — optional (web uses Tailwind classes)
```

Hooks and plain modules stay single files by default (`useCart.ts` + `useCart.test.ts`) and adopt the same folder shape only once they accrue companions.

**Tests.** Unit tests are co-located next to the module and name-matched (`Button.test.tsx`, `useCart.test.ts`) — see `bun test` in the shared core. End-to-end tests live in a top-level `e2e/` at the repo root (Playwright for Web; the project's chosen runner for Universal).

**Shared tree (both profiles):**

```text
.
├── convex/                 # Convex backend: functions, schema.ts, auth.config.ts (root, toolchain)
├── e2e/                    # end-to-end tests (root)
├── plop-templates/         # generator templates (root)
├── plopfile.ts             # (root)
├── public/                 # static assets (root)
├── src/
│   ├── app/                # routes ONLY — framework-owned (see profile section)
│   ├── components/
│   │   ├── atoms/          # each component is a folder (see above)
│   │   ├── molecules/
│   │   └── organisms/
│   ├── hooks/              # useThing.ts (+ useThing.test.ts)
│   ├── types/
│   ├── <domain>/           # auth/, billing/, … domain logic and modules
│   └── providers.tsx       # ClerkProvider + ConvexProviderWithClerk wiring (one export)
└── …config at root         # tsconfig.json, biome.json, knip.json, lefthook.yml, etc.
```

`src/app/` is **routes only** — never put components, hooks, or utilities there (Expo treats stray files as routes; Next.js follows the same rule for parity). Route-private, single-use pieces:

- **Web (Next.js):** colocate inside the route segment in a private folder (`src/app/(dashboard)/_components/`, `_hooks/`). Promote to `src/components` / `src/hooks` once reused by more than one route.
- **Universal (Expo):** keep them under `src/` (by domain or feature); `src/app/` stays routes-only.

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
- **Routes:** under `src/app/`. Route files keep their framework-mandated names: `page.tsx`, `layout.tsx`, `loading.tsx`, `error.tsx`, `not-found.tsx`, `route.ts` (route handlers), route groups `(group)`, dynamic segments `[param]`, private folders `_components/` / `_hooks/` for route-local code.
- **Providers & proxy:** `src/app/layout.tsx` renders `src/providers.tsx` (`<ClerkProvider>` + `<ConvexProviderWithClerk>`); `src/proxy.ts` holds the Clerk request handler (Next.js 16 renamed the former `middleware.ts` convention to `proxy.ts` — `export function proxy`, Node.js runtime by default); `src/app/globals.css` is the Tailwind entry. `next.config.*`, `postcss.config.*`, and `tsconfig.json` stay at the repo root.
- **Rendering — use the narrowest mode per route:**
  - **SSG** for content that rarely changes (use `generateStaticParams`, static imports, cached data).
  - **SSR** when every request needs fresh or personalized data (auth/session, headers/cookies).
  - **ISR** for periodically refreshed static pages via segment `revalidate`, `revalidatePath`, `revalidateTag`.
- **Deployment:** Vercel.

### Profile: Universal (Expo Router)

- **Framework:** Expo (latest stable) with Expo Router.
- **Routes:** under `src/app/` (Expo Router SDK 55+ default; `src/app/` takes precedence over a root `app/`). Route files keep their framework-mandated names: `_layout.tsx`, `index.tsx`, dynamic `[id].tsx`, route groups `(group)/`, `+not-found.tsx`; kebab-case route segments. `src/app/_layout.tsx` renders `src/providers.tsx`.
- **Config at root:** `app.json` / `app.config.ts`, `eas.json`, `metro.config.js`, `tsconfig.json` (with `@/*` → `./src/*`), and `public/` stay at the repo root.
- **Styling:** React Native `StyleSheet` (`StyleSheet.create`), per-component styles in the component folder's `*.styles.ts` companion. No Tailwind/NativeWind by default.
- **Native packages:** `@react-native-async-storage/async-storage` (persistence), `@react-native-community/netinfo` (connectivity), `react-native-reanimated`, `react-native-gesture-handler`, `expo-router`, `expo-updates`, Expo Google Fonts.
- **Toasts:** `sonner-native` (mirroring `sonner` on web).
- **Builds:** **EAS** for iOS/Android (`eas build`, `eas submit`). **Vercel** for the web target.

---

### Rules

- **Project profile is explicit.** Every project on this skill is one of `web` or `universal`, and the choice is documented (in `AGENTS.md`, `docs/architecture.md`, or the equivalent). If neither fits, the project's own AGENTS.md takes precedence over this skill.
- **Project structure follows the canonical tree.** Routes under `src/app/` (both profiles) and nothing but routes there; all other source under `src/` by domain; Atomic Design components as folders. One public export per file, the filename matches the export, and no barrel (`index.ts`) re-export files. Deviations are documented in the project's `AGENTS.md`.
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

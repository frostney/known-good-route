---
name: bleeding-edge
description: >-
  Biases technology choices toward the newest viable option while preserving
  maintainability, live verification, reversibility, and decided constraints.
  Use when selecting or upgrading a dependency, runtime, tool, language feature,
  or AI model.
license: Unlicense OR MIT
---

# Bleeding edge

This is the lens you apply to every technology choice: reach for the newest option that can actually carry the work, so the system keeps up with the ever-changing times instead of quietly calcifying on yesterday's defaults.

## The why

Unmaintained software rots: support lapses, security debt piles up, and the gap to current widens into a migration you can't afford. Staying current is cheaper paid continuously. So the default heading is *forward* — reach for the newer option and make the older one earn its keep.

This is a **bias on the default**, not a mandate. It sits *beneath* `software-engineering-excellence` (SEE): SEE remains the governor and **maintainability is still the tiebreaker**. Bleeding edge tilts which option you reach for first; it never lowers SEE's bar. Keeping up lives *inside* the known good route, not outside it.

## Scope

This lens governs how *current* a technology choice is. It applies to:

- **Versions** of dependencies, frameworks, and runtimes.
- **Newly-stable language and platform features** — recently-shipped syntax, std-lib APIs, and platform capabilities, preferred over older idioms.
- **Tooling** — build tools, linters, package managers, test runners; favour the modern successor over a stagnant incumbent.
- **AI models and capabilities** — the current generation of models, APIs, and SDK features.

It does **not** govern architecture or design paradigms. This is about adopting newer *technology*, not inventing newer *designs* — novel architecture is a separate decision made on its own merits, not something to chase for being new.

## The stability ladder

There is a gradient from proven to fresh. Pick the lowest rung that meets the need, and climb only with a reason:

| Rung | When to use it |
| --- | --- |
| **Newest stable** (the default) | Always reach here first. Include **just-released major versions** — a new major that has shipped stable is in-scope by default, not something to wait out. |
| **RC / beta / canary** | Only when a concrete need justifies it (it unblocks something real) **or** the case is genuinely low-risk and reversible. |
| **Nightly** | Only with a **documented reason** stating what it unblocks. Never the default, never silent. |

The higher the rung, the heavier the justification and the safeguards it must carry (below).

## Mandatory guardrails

Every adoption under this lens must satisfy all six. These are the audit-checkable invariants — an adoption that skips one is not "bleeding edge," it is reckless.

1. **Verify versions live.** Confirm the current version *and* its release status from the registry or official release notes before adopting — never from memory or a prior turn. (This is the repo-wide "verify versions live" rule; it applies here with full force.)
2. **Pin exact versions** for anything past newest-stable. RC/beta/canary/nightly are pinned to an exact version, never a floating range.
3. **Reversibility and an exit plan.** The adoption must be cheap to roll back, and the reason plus the fallback are recorded (PR description / decision log).
4. **Green on the full validation gate.** The project's real check/test/lint gate must pass with the new version. Never weaken the gate to make an adoption fit.
5. **No known blocking issues.** Check the changelog and issue tracker first; do not adopt a release with open blockers for your use case.
6. **A documented reason to climb** past newest-stable — and especially for nightly — stating what it unblocks.

## Decided choices are not yours to swap silently

When a stack skill, `AGENTS.md`, or the project has already committed to a specific tool or framework, that decision stands (SEE: *hold decisions stable*).

- **Apply the bias *within* the decided choice** — push to the newest version and features of the tool that is already chosen.
- **Never silently replace a decided tool**, and never violate an `AGENTS.md` Hard Constraint to adopt something newer.
- **If a newer tool would genuinely beat the incumbent**, surface it as a visible recommendation for the human to decide — out loud, with the tradeoff — rather than swapping it in.

## The guard against excess

Maximised, this lens becomes churn: novelty for its own sake, working code rewritten for a version bump, reproducibility traded for a shinier badge. Guard against it.

- **Newer must pay for itself.** A higher version number is not a reason. The adoption has to deliver real value — capability, security, performance, developer experience, or longevity — that outweighs the instability it brings.
- **Don't churn what works** and don't break reproducibility to chase the latest.
- **Maintainability stays the tiebreaker.** When the newer option makes the next change harder, it loses — being current is a means to a healthier system, not the goal itself.

When the choice is genuinely unclear, surface it (SEE: *hold the line under uncertainty*) — state the rung, the reason to climb, and the safeguards — rather than quietly picking the flashiest option.

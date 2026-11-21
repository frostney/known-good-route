# Stack review readiness

Readiness belongs to the complete native stack selected by its repository-scoped
stack number. Lower members can be reviewed and covered without becoming
independently merge-ready.

## Member states

- `reviewed`: CI and every intentionally active review provider reached
  a terminal result for the member's exact head, and every returned finding
  surface was inspected and classified.
- `covered`: The member is reviewed and every finding is moot at the integrated
  top, satisfied by an exact descendant commit, fixed by an exact commit in a
  required top fix layer, or declined with accepted evidence. Every originating
  inline thread has a maintainer-workflow reply and is resolved.
- `pending`: CI, review, provider availability, thread handling,
  validation, or live-membership evidence is incomplete.
- `blocked`: A material decision, unsafe mutation, unresolved human judgment,
  invalid stack, unavailable required provider action, failed validation, or
  unexplained topology prevents safe convergence.

A covered lower member can still contain the reported flaw at its own head. Its
coverage therefore depends on every named fix layer above it and does not admit
a partial merge.

## Frozen members and invalidation

This is the one definition of frozen that the other stack guides link to. A
member becomes frozen once CI on its exact head has passed and its review is
terminal with every finding surface classified, or once it is ready for review,
whatever its review verdict. Classify a terminal review's findings before
placing any fix, so a draft whose CI passed and whose review is terminal is
frozen by the time its fix is placed. A draft whose CI on its exact head
failed, was cancelled, is still running or never ran is not frozen, even after
its review finished: while no member above it is frozen, its fixes go in place
on it. This workflow never pushes to a frozen member, and adds a new top layer
only for fixes above a frozen member. The protected push helper cannot see when
a review ends, so it refuses to move a member that is ready for review or a
draft whose CI passed. A draft whose CI passed but whose review has not
finished is not frozen: list its ref under `rewrite` with `draftOnly`, naming
the unfinished review as the reason, to fix it in place; the helper still
refuses it once it is ready for review. Fix a member in place only when it and
every member above it are not frozen, because the push moves them all and
restarts their CI. Apart from a `draftOnly` entry, the only rewrite is the
final rebase before merging the whole stack, under `git-workflow`'s [native
stack
reference](../../git-workflow/references/github-stacks.md#guarded-rewrite-exception);
it changes every head, so the changed-head rule below applies to every member.

- Appending one expected fix layer above an unchanged prefix preserves the
  prefix's evidence. The new member remains pending until reviewed and covered.
- A changed head at position N invalidates CI, review, validation, and coverage
  for position N and every descendant.
- A changed base, removed or reordered member, replaced stack identity, or
  unexplained stack closure invalidates from the first affected position. When
  no safe affected position can be established, invalidate the whole stack.
- An externally appended member does not rewrite the prefix, but it changes the
  confirmed scope. Adopt it only when current evidence proves it belongs to the
  stack claim; otherwise stop for scope resolution.
- A review, check, reply, or provider completion for a previous head never
  satisfies a current-head gate.

Use `scripts/stack_state.py inspect --expect <snapshot>` to distinguish an
unchanged stack, an append-only member, and invalidating topology or head drift.
Use its `wait` operation only when stack change itself is the awaited
transition.

The helper resolves the base branch's current commit independently: the native
Stacks API may supply only its name. It verifies that topology and base remain
stable across the observation. A racing packet is retried by `wait`; an
unverified observation never establishes that the stack was unchanged. Legacy
checkpoints without an exact base commit require fresh evidence.

## Complete-stack ready gate

The complete stack is `ready` only when all conditions are simultaneously true:

- the final native snapshot has the same stack identity, base, order, and exact
  heads used by the final evidence pass;
- every current member is reviewed and covered;
- every required behavior has observed black-box evidence on the final
  integrated top tree;
- the declared project gate passed for that same final content;
- every check on every member's head is terminal and passed, counted as the
  [PR gate](pr-readiness.md#terminal-exact-head-gate) counts them;
- every intentionally active provider has terminal evidence for each head it
  was required to review;
- every layer that took a fix, in place or as an appended fix layer, has no
  actionable finding at its current head;
- every source and fix-layer thread has a maintainer-workflow reply;
- GitHub reports zero unresolved threads across the stack;
- no paid review capacity, bypass, or merge is required to claim readiness; and
- a final live-membership audit contains no unreviewed member.

Reviewing the initial member list, draining a trigger queue, fixing every known
finding, or obtaining a clean top review is insufficient by itself. Readiness is
the fixed point where all four agree: live native membership, exact heads,
finding coverage, and terminal provider evidence.

## Result meaning

`ready` applies only to the whole live stack and means it can be returned to its
caller for a separately authorized atomic merge. `pending` names the exact
transition or safe `retry_at`. `blocked` names the decision or failure that
cannot be resolved inside the current authority. This workflow never returns
`merged`.

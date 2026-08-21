# CodeRabbit review adapter

Use this adapter only when repository policy or current stack activity confirms
CodeRabbit is intentionally active. Its rules are provider-specific and do not
change the core stack or readiness contracts.

## Trigger and completion

- CodeRabbit may automatically review only a member whose effective base is the
  repository default. Inspect what current `ready_for_review` and synchronization
  events actually trigger. Post the documented manual command only where an
  exact-head review is still absent.
- Keep one trigger in flight across the authenticated account. Before posting a
  command, inspect every stack member and other recently active CodeRabbit PRs
  for the newest fair-usage response. The limiter is account-scoped even when
  its edited comment appears on another PR.
- Use `@coderabbitai review` for an unreviewed exact head. Escalate to
  `@coderabbitai full review` only when CodeRabbit explicitly refuses the
  incremental request as already reviewed, or when an immediate completion ack
  does not establish that the current diff was analyzed.
- A completion is either a review object explicitly reporting actionable
  comments or a finished/no-actionable acknowledgment after the trigger. Empty
  COMMENTED reviews created by thread replies, review-count changes, walkthrough
  summaries, and check success alone are not completion evidence.
- Bind review objects to the exact PR head through their commit OID. An ack-only
  completion also needs current walkthrough coverage of changed files and must
  not be an immediate incremental no-op. Coverage qualifies an ack; it never
  proves by itself that a review ran.

## Fair-usage waits

- Never invent a fallback delay. The terse rate-limit response carries no safe
  time; wait until the account fair-usage comment supplies one.
- The fair-usage comment is edited in place. Select the newest matching comment
  by `updated_at`, not `created_at`. Parse the documented available-in duration
  despite Markdown formatting, and calculate `retry_at` from that update time
  plus the stated duration and a 60-second buffer.
- Continue checking the triggered PR for completion during the stated wait.
  The stated duration is an upper bound and a running review can finish early.
  Re-trigger only after the explicit time elapses without completion.
- Serialize through one machine-wide lock keyed by authenticated CodeRabbit
  account identity. Do not start parallel queues in separate stacks or sessions.
- Never enable the provider's usage-based paid review option. If free review
  cannot complete, return `pending` with the exact retry time or `blocked` when
  no safe time or trigger can be established.

## Round behavior

Trigger each frozen initial member at most once for its exact head. Linkback
acknowledgments are not another review round. After live findings land in a new
top fix layer, review that new exact head; do not re-trigger unchanged frozen
members. Reconcile the native stack after every fix layer because the provider's
trigger list is fixed while the stack can grow.

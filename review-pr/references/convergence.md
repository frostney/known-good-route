# Pull-request convergence

`review-pr` owns one PR and one exact current head at a time. Re-read forge state
after every thread action, commit, push, baseline update, automation response,
or check transition; delegated output is evidence to verify, not gate state.

## Terminal exact-head gate

Record the repository, PR number or URL, and final head object ID. A PR is
`ready` only when all conditions are simultaneously observed for that head:

- every required check is terminal and successful;
- every intentionally active review automation has a terminal completed verdict
  explicitly tied to that head, with no newer incomplete or follow-up review;
- no actionable current-head finding remains;
- the forge reports zero unresolved review threads;
- every inline automation thread has a maintainer-workflow reply in that thread;
  and
- no CI, verdict, finding, reply, or thread-readiness evidence belongs only to a
  previous head.

Resolving without replying does not satisfy the gate. If a thread cannot accept
an inline reply, return `blocked` with that thread identity. Any new head
invalidates the complete gate snapshot; never patch old and new evidence
together.

## Inline delegation contract

When `resolve-reviews` is registered, give it the repository, PR identity, and
head. It owns inline mechanics: fetch and classify every current inline finding,
publish scoped fixes through the repository workflow, reply in the originating
thread, resolve completed threads, and detect follow-ups. Require it to return
thread identities, classifications, actions, observed head, and limitations.

`review-pr` retains convergence ownership. Re-read the forge directly and
verify the final head, unresolved count, unanswered automation-thread count,
findings, checks, and automation states. When the registered skill is absent,
perform the same mechanics and preserve the same result contract.

## Provider-neutral retry time

For an incomplete or rate-limited automation response:

1. Read the response's `createdAt` and its explicit absolute availability time
   or stated duration.
2. For a duration, calculate `availability = createdAt + duration`; never anchor
   it to observation time.
3. Calculate `retry_at = availability + 60 seconds` and preserve its timezone in
   an unambiguous RFC 3339 value.
4. Use that exact timestamp for a supported standalone wake-up and expose it to
   any orchestrating caller.

If no exact absolute time or duration exists, set no `retry_at` and remain
`pending`. Do the same when timing statements conflict, cannot be parsed
unambiguously, or do not clearly describe availability. Never infer a provider,
account quota, hourly window, blind delay, or retry count.

## Result contract

Return:

- repository and PR identity;
- exact head object ID;
- `state`: `ready`, `pending`, `blocked`, or `merged`;
- required-CI terminal state;
- each active automation and its exact-head terminal state;
- actionable current-head finding count;
- unresolved review-thread count;
- unanswered inline-automation-thread count;
- safely derived `retry_at` or `null` with the reason; and
- blocker, merge result, or next required evidence.

Normal mode may reach `ready` but never `merged`. A stack member may reach
`ready`, but stack admission, scheduling, and merge remain the caller's job.

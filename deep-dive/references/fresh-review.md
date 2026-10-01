# Fresh review

Read this before starting the reviewer for a deep dive.

## Choose the route

Use the reviewer the caller names. Otherwise:

- When the host can start a subagent or worker with its own context, use it.
  Do not pass the conversation or your reasoning; pass only the packet below.
- Without one, run the review as a separate non-interactive CLI process with the
  packet on standard input, for example `claude -p --no-session-persistence` or
  `codex exec --ephemeral --sandbox read-only`. Restrict it to read-only tools
  where the CLI allows it.
- When a route returns no verdict, try the next available one. Only when no
  route returns a verdict is the result unreviewed. Say so in the report; do
  not describe your own recheck as a fresh review.

Record the route, the model, and, for a CLI run, the exact command and its exit
status. A recorded request or a started reviewer without a returned verdict is
not a review.

## The packet

- The observed symptom, in the terms the person used.
- The surviving explanation, or the gap and the open candidates.
- Each piece of evidence with the exact source it came from, such as a file
  path, command, transcript, run ID, or log.
- Each ruled-out candidate with the observation that ruled it out.
- The instruction to reread the sources, try to break the explanation, check
  that each source says what is claimed, and return `agree` or `disagree` with
  the evidence for it.
- The boundary: read-only, and no further reviewer.

## Use the verdict

When the reviewer disagrees, check its evidence against the sources. If it
holds, the explanation is reopened: run the probes again and review the new
result. If it does not hold, keep the explanation and state in the report why
the objection failed.

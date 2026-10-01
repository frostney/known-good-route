# Fresh review

Read this before starting the reviewer for a deep dive.

## Choose the route

Use the reviewer the caller names. Otherwise:

- When the host has a tool that starts a subagent or worker with its own
  context and returns its result, use it. Do not pass the conversation or your
  reasoning; pass only the packet below. A tool that only records that you
  requested a review does not start one.
- Without one, run the review as a separate non-interactive CLI process with the
  packet on standard input, for example
  `codex exec --ephemeral --sandbox read-only -o verdict.md` or
  `claude -p --no-session-persistence > verdict.md`. Restrict it to read-only
  tools where the CLI allows it.
- When a route returns no verdict file, try the next available one. Only when
  no route produces one is the result unreviewed. Say so in the report; do not
  describe your own recheck as a fresh review.

## The verdict file

The verdict must exist outside your own report, in a file the reviewer wrote:
through a verdict tool the reviewer has, or as the CLI's last message written
to a file. Cite its exact path in the report next to the verdict. Record the
route, the model, and, for a CLI run, the exact command and its exit status. A
claimed review without a verdict file to cite is unreviewed.

## The packet

- The observed symptom, in the terms the person used.
- The surviving explanation, or the gap and the open candidates.
- Each piece of evidence with the exact source it came from, such as a file
  path, command, transcript, run ID, or log. Name where each source lives so
  the reviewer reads it itself; do not paste its content in its place. A
  reviewer that judged only your excerpts has not reread anything.
- Each ruled-out candidate with the observation that ruled it out.
- The instruction to reread the sources, try to break the explanation, check
  that each source says what is claimed, and write `agree` or `disagree` with
  the evidence for it to a verdict file once, through its verdict tool when it
  has one, and return that file's path. However you word the packet, keep
  this: the reviewer's reply is not the verdict file.
- The boundary: read-only except for that one verdict file, and no further
  reviewer.

## Use the verdict

When the reviewer disagrees, check its evidence against the sources. If it
holds, the explanation is reopened: run the probes again and review the new
result. If it does not hold, keep the explanation and state in the report why
the objection failed.

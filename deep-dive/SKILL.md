---
name: deep-dive
description: >-
  Establishes the actual cause of something observed by checking what really
  ran or loaded, trying to break each candidate explanation, and having the
  result reviewed in a fresh context before reporting it. Use before claiming a
  cause or proposing a fix for an observed failure, hang, leak, or unexpected
  agent behavior, when asked why something happened or what is causing it, or
  when the user runs /deep-dive.
license: Unlicense OR MIT
---

# Deep dive

The person should not have to ask you to check what actually happened. Before
you name a cause or propose a fix for something observed, establish the cause
from the record of what ran, try to break it, and have it reviewed in a fresh
context.

## Look at what actually ran

Start from the record, not the story about it. Depending on the problem, that
is the session transcript and the instructions and skills it actually loaded,
logs, CI runs and the revisions they ran on, process and lock state, and the
deployed version. A process name, a status message, a teammate's note, a PR
description, or a file that should have been loaded is a lead until the record
confirms it.

Do not stop at the first explanation that fits. Raise every candidate the
evidence suggests. A cause says why it happened, not only what happened: for
each confirmed link, ask what produced or allowed it, such as an instruction,
an input, or a check that never ran, and follow that back while the evidence
reaches. There is no fixed number of candidates.

Use read-only probes. Diagnosis does not authorize killing processes, releasing
locks, editing, rewriting history, or publishing.

## Try to break every candidate

Run two probes on each candidate explanation and keep both results:

- **Falsification:** look for the observation that would be impossible if the
  candidate were true, such as an ordering, a timestamp, a load event, an
  identical hash, or a probe that tells two candidates apart, and check it.
- **Truthiness:** reread each source you cite and confirm it says what you
  claim, about the object and time you claim. A source that only repeats
  someone's belief is a lead, not evidence.

A candidate that fails either probe is ruled out by the observation that broke
it.

## Get a fresh review

Before returning, have the result reviewed in a fresh agent context: a subagent
when the host has one, otherwise a separate CLI run such as `claude -p` or
`codex exec`. Use the reviewer the caller names. Read
[references/fresh-review.md](references/fresh-review.md) before starting it.

The reviewer gets the symptom, the surviving explanation or the gap, each piece
of evidence with its source, and each ruled-out candidate with what ruled it
out. It rereads the sources, tries to break the explanation, and returns agree
or disagree with its evidence. Only a returned verdict counts: a recorded
request is not a review, and a route that returns none means trying the next
one. A disagreement that holds reopens the investigation.

## Stop

Stop only when one of these holds:

- One explanation survives both probes and the fresh review, and every other
  candidate you raised is ruled out with evidence.
- The evidence runs out. Report what is missing, where you looked, and which
  candidates remain open, without choosing between them.

## Report

Keep it short:

- the surviving explanation as a cause, back to its earliest supported link,
  or the gap;
- the evidence, each item with its source;
- each ruled-out candidate and the observation that ruled it out;
- the falsification and truthiness results;
- which reviewer ran, by route and model, and its verdict.

Propose a fix only after this, and only for the surviving cause.

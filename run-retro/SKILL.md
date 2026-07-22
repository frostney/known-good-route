---
name: run-retro
description: >-
  Reviews a completed workstream from conversation, repository, and forge
  evidence, uses grilling to agree improvements to delivery speed, process, and
  codebase health, then applies selected documentation edits and follow-up
  ticket actions. Use when ending a substantial workstream or running a project
  retrospective.
license: Unlicense OR MIT
compatibility: >-
  Requires a registered grilling skill and access to the current workstream's
  available conversation, repository, and forge evidence. Creating selected
  tickets also requires the create-issue skill and forge access.
---

# Run retrospective

## Instructions

Review the completed workstream through delivery-speed, process, and codebase
health lenses. Use the actual `grilling` skill to reach shared understanding,
then present a detailed summary. Apply only the documentation edits and
follow-up ticket actions the user selects from that summary.

### Non-negotiable gates

#### GATE A — Ground the retrospective in workstream evidence

Use the current workstream conversation together with the repository and forge
evidence it produced. Inspect the relevant diff, commits, issues, pull requests,
reviews, checks, rework, and missed or successful gates. Look facts up rather
than asking the user to recall them.

If an evidence source is unavailable, record the absence and lower confidence;
never fill the gap with memory or an unsupported narrative. Keep the evidence
scope tied to the workstream rather than turning the retrospective into an
unrelated repository audit.

#### GATE B — `grilling` owns the decision loop

The registered `grilling` skill is a hard dependency. Invoke the actual skill,
give it the evidence and candidate lessons, and let it ask every decision
question one at a time with a recommended answer. Do not imitate its style or
replace it with an ad-hoc interview. If `grilling` is unavailable, stop with a
clear dependency message.

Do not act until `grilling` has reached shared understanding and the user
explicitly confirms the exact action set.

#### GATE C — Assess three lenses and promote only durable lessons

A promoted lesson must be generalized, project-level, and supported by the
workstream evidence. Do not turn one-off mistakes, session chronology, personal
preferences, rules already covered, or speculative improvements into permanent
project policy.

Assess every workstream through all three lenses, even when a lens produces no
durable finding:

- **Delivery speed:** faster safe delivery through less waiting, rework,
  handoff friction, unnecessary scope, or cognitive load. Never reward raw
  output or shortcuts that weaken correctness, maintainability, or review.
- **Process:** planning, decisions, handoffs, gates, tools, and collaboration.
- **Codebase:** architecture, maintainability, tests, developer experience,
  reliability, and accumulated friction.

Route each durable lesson to the smallest effective intervention:

- **Documentation edit:** durable guidance belongs in existing repository
  documentation, including project contracts, READMEs, `docs/`, ADRs,
  `AGENTS.md`, skill documentation, templates, policies, and contributor
  guidance. Prefer tightening, replacing, or coupling with existing text over
  adding a new passage. Keep proposed wording concise.
- **Follow-up ticket:** concrete implementation is needed. Propose a concise
  ticket summary and let the user request more detail, grill it further, create
  it through `create-issue`, create it in `create-issue` automatic mode, or skip
  it. The delegated skill retains its own investigation and grilling gates.
- **Report only:** the observation is useful but warrants no durable edit or
  ticket.

Use both a documentation edit and a ticket only when the edit establishes
durable guidance and the ticket is separately necessary to enact it. Direct
edits are limited to documentation; propose source-code and executable
configuration changes as tickets instead.

#### GATE D — Exact selection authorizes actions

After grilling reaches shared understanding, present the detailed summary with
findings under all three lenses, exact proposed documentation changes, concise
ticket summaries, supporting evidence, and report-only observations. The user
chooses which document edits and ticket actions to authorize.

An existing document may be edited after confirmation. A missing document may
be created only when its creation and proposed contents are explicitly
selected. If the user requests more ticket detail or grilling, return to the
`grilling` loop and regenerate the detailed summary before acting.

Confirmation authorizes only the selected actions. It does not authorize
commits, pushes, pull requests, unselected issue changes, or edits to other
files.

### Steps

1. **Resolve the workstream.** Identify the repository, completed task, linked
   issues or pull requests, and the time or turn boundary of the work being
   reviewed. Use the current conversation and `.agent/HANDOFF.md` when
   available; state any boundary that remains uncertain.
2. **Read the project documentation.** Search the root, relevant product areas,
   and `docs/` for project contracts and other documentation that may already
   carry each lesson. Read every relevant match before proposing changes and
   record material absences.
3. **Build an evidence ledger.** Record concrete outcomes, friction, rework,
   surprises, missed expectations, gates that failed or caught problems, and
   successful practices worth preserving under all three required lenses. Link
   every candidate lesson to the conversation, repository, or forge evidence
   that supports it.
4. **Filter and classify.** Remove duplicates, already-covered rules,
   session-specific details, and claims without evidence. Classify the remaining
   candidates as Documentation edit, Follow-up ticket, both, or Report only
   using GATE C.
5. **Invoke `grilling`.** Give it the workstream boundary, evidence ledger,
   relevant documentation, absences, and classified candidates. Complete its
   one-question-at-a-time loop; all unresolved judgments belong in that loop.
6. **Present the detailed summary.** Show findings under all three lenses, exact
   proposed additions, replacements, or removals per document, concise ticket
   summaries with their available actions, evidence and rationale, and
   report-only observations.
7. **Confirm selections.** Obtain explicit selection of the document edits and
   ticket actions. Do not treat the original request to run a retrospective as
   this final confirmation. Return to grilling and regenerate the summary when
   the user requests further exploration.
8. **Apply selected documentation edits.** Preserve each document's structure
   and voice, make the smallest coherent change, and avoid duplicating or
   contradicting existing guidance. Create a missing document only when
   explicitly selected and follow the project's documentation conventions.
9. **Run selected ticket actions.** Hand each selected proposal to
   `create-issue` in the mode the user chose. Do not create skipped or unselected
   tickets.
10. **Verify.** Inspect the final diff against the confirmed edit set, re-read the
   affected sections for conflicts or accidental scope expansion, and run the
   project's declared documentation or markdown checks when available. Never
   invent a validation command.
11. **Report.** Summarize changed documentation, created tickets, report-only
    improvements, unavailable evidence, confidence limits, and verification
    results.

### Output

Before confirmation, provide:

1. **Findings by lens** — evidence-backed delivery-speed, process, and codebase
   lessons, including lenses with no durable finding.
2. **Proposed documentation changes** — concise exact edits grouped by file,
   including any proposed document creation.
3. **Proposed follow-up tickets** — concise summaries with options for more
   detail, further grilling, normal or automatic creation, or skipping.
4. **Report-only improvements** — useful findings intentionally not promoted.
5. **Confidence and gaps** — unavailable sources or uncertain boundaries.

After applying the selected actions, provide a concise changed-files summary,
created issue links, and verification evidence. Keep the retrospective narrative
in chat; do not add session history to project documentation.

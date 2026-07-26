---
name: run-retro
description: >-
  Reviews a completed workstream from conversation, repository, and forge
  evidence, uses grilling to agree durable lessons, and updates project vision
  and readiness/completion definitions after confirmation. Use when ending a
  substantial workstream or running a project retrospective.
license: Unlicense OR MIT
compatibility: >-
  Requires a registered grilling skill and access to the workstream's available
  conversation, repository, and forge evidence.
---

# Run retrospective

## Instructions

Turn a completed workstream into agreed durable project improvements. The
`grilling` skill owns the decision loop; document edits require confirmation of
the exact wording.

### Gates

- Define the workstream boundary and inspect its conversation, handoff, diffs,
  commits, issues, PRs, reviews, checks, rework, and outcomes. Record unavailable
  sources and lower confidence; do not invent a narrative.
- Invoke the actual `grilling` skill with the evidence and candidate lessons. Do
  not replace it with ad-hoc questions. Stop if it is unavailable.
- Promote only generalized, project-level lessons supported by evidence. Exclude
  session chronology, one-off mistakes, personal preferences, duplicates, and
  speculation.
- Edit documents only after `grilling` obtains explicit confirmation of the
  complete, exact edit set.

### Scope

Classify durable lessons by destination:

- `VISION.md`: purpose, users, outcomes, scope/non-goals, strategy, architecture.
- `DEFINITION_OF_READY.md`: evidence, decisions, dependencies, acceptance
  criteria, and conditions before work starts.
- `DEFINITION_OF_DONE.md`: implementation, verification, review, documentation,
  delivery, and operational completion.
- Report only: useful findings that belong elsewhere or require implementation.

Direct edits are limited to the three project contracts. A missing contract may
be created only when its creation and contents are part of the confirmed set.
Confirmation does not authorize commits, pushes, PRs, issue changes, or other
file edits.

### Workflow

1. Resolve the workstream and read the current project contracts.
2. Build an evidence ledger of outcomes, friction, rework, successful practices,
   and failed or effective gates.
3. Filter and classify candidate lessons using the scope above.
4. Run `grilling` one decision at a time until the durable lessons and exact
   proposed edits are understood.
5. Present evidence-backed lessons, exact edits grouped by contract, report-only
   findings, and confidence gaps.
6. Obtain explicit confirmation through `grilling`; revise and reconfirm if the
   proposal changes.
7. Apply only the confirmed edits, preserving each document's structure and
   avoiding duplication.
8. Compare the diff with the confirmed set and run declared documentation checks.
9. Report the durable outcome and observed validation. Keep session history in
   chat, not in project contracts.

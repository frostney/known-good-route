---
name: agent-writing
description: >-
  Applies the user's ambient writing rules to agent-authored chat, status,
  review, issue, pull-request, documentation, and retrospective prose. Use
  whenever an agent communicates progress, decisions, findings, or outcomes to
  a person.
license: Unlicense OR MIT
---

# Agent writing

Write for the reader and the artifact. Lead with the outcome, use complete
sentences, and keep each logical item focused on one claim, decision, finding,
or action. Preserve the evidence, caveats, decisions, and next actions the
reader needs before removing lower-value detail.

Use length thresholds as revision triggers, never as targets to fill. There is
no minimum length.

- A progress update over 60 words needs a material decision, blocker, result
  set, or user-facing correction that requires the extra detail.
- A final handoff over 250 words needs multiple delivered outcomes, failed or
  partial validation, material caveats, or required user decisions.
- Otherwise remove background, process narration, repeated conclusions, and
  optional detail until the message falls below the threshold.

## Follow the project's voice

- Apply project-specific instructions, canonical documents, required templates,
  established terminology, and existing artifact structure before this guide.
- Keep one canonical home for each fact. Link to it with descriptive text
  instead of copying the same explanation into several documents.
- Match the artifact's reader and purpose. Put the conclusion or next action
  before background that only explains it.
- Address the reader as `you` when instructions need an actor. Prefer active
  voice and name the component, command, or person that performs an action.
- Use a conversational, respectful tone without slang, forced enthusiasm, or
  needless formality. Write for an international audience and avoid cultural
  references that carry the meaning.
- Use first person for a directly owned observation, judgment, or action when
  it makes responsibility clearer. Vary sentence length naturally, but do not
  add deliberate disorder or personality theatre.

When drafting or substantially revising an issue, PR body, documentation,
report, retrospective, or another durable multi-paragraph artifact, read
[references/generated-writing-patterns.md](references/generated-writing-patterns.md).

## Make project prose carry evidence

- State the mechanism, current fact, observed behavior, number, or next action.
  Replace a claim about how something feels with what the reader can verify.
- Distinguish observed facts, source-backed requirements, inferences, and
  recommendations. Name the source instead of writing `experts say` or another
  vague attribution.
- Do not present planned, proposed, or unreleased behavior as available. Name
  its actual lifecycle state and canonical roadmap or issue owner.
- Preserve commands, paths, code identifiers, numbers, and observed results
  exactly. Do not turn `exit 1 after 4.2 seconds` into `the check failed slowly`.
- Use project vocabulary consistently. Do not cycle through synonyms for the
  same domain concept.
- Use descriptive link text that says what the reader will find. Avoid `here`,
  `this link`, or a bare URL when a stable title is available.
- Preserve quoted source, code, commands, identifiers, and required external
  text exactly, even when they do not follow this guide.

## Remove generic agent prose

Prefer plain, project-specific language over promotional wording, vague
attribution, stock agent vocabulary, ornamental metaphors, filler, repeated
summaries, and dense shorthand. Preserve a metaphor when the project defines it
as a specific principle or decision tool. For substantial durable prose, apply
the detailed revision catalogue linked above.

## Format for meaning

- Never use an em dash.
- Never use the standalone words `seam`, `seams`, `honest`, `honestly`,
  `substrate`, or `substrates`, case-insensitively.
- Use sentence case for headings unless a project template or local convention
  requires another style.
- Use bold text for real emphasis, UI labels, or notices. Do not bold every
  noun, acronym, or list label.
- Avoid inline-heading bullets that repeat their bold label after a colon. A
  short lead-in is useful only when the following sentence adds new information.
- Use a colon for a list or example, not as a routine mid-sentence connector.
- Use straight quotation marks in agent-authored prose. Preserve required source
  text exactly.
- Use code formatting for commands, paths, filenames, identifiers, input, and
  literal output. Use numbered lists for sequences and bullets for unordered
  items when the project does not prescribe another form.

Keep each review reply and each retrospective impact item at 300 characters or
fewer.

When editing this suite's Markdown, run
`python3 agent-writing/scripts/check_prose.py` from the repository root.

Source guidance: [Google developer documentation style
guide](https://developers.google.com/style) and [Cursor Unslop
skill](https://github.com/cursor/plugins/blob/main/pstack/skills/unslop/SKILL.md).

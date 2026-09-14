# Skill behavioral evaluations

Run the portable skill contracts through native Codex and Claude CLI sessions
using their saved local subscription logins. No Vercel AI SDK, gateway, API key,
or copied authentication token is needed. Live runs consume account usage.

For routine changes, start with the bounded [acceptance strategy](ACCEPTANCE.md).
The larger suite below is supporting regression and diagnostic infrastructure;
its full model matrix is not a mandatory gate for every skill edit.

For PR description and walkthrough changes, select cases that cover final-change
writing, explicit Testing templates, current before/after evidence and incomplete
media capabilities. Assess whether the agent reports each missing requirement
and remedy while continuing otherwise-authorized publication. The contracts live
in [PR descriptions](../agent-writing/references/pr-descriptions.md) and
[walkthroughs](../create-pr/references/walkthroughs.md).

Keep instruction-following evidence separate from media execution. A paper
scenario or simulated tool receipt cannot establish a real recording, audible
voice-over, synchronized subtitles, playback quality or uploaded asset. A local
media demonstration establishes only its recorded host, tools and completed
stages; macOS output does not establish Linux or Windows support. Inspect the
actual exported file and reviewer-accessible upload for those claims, and retain
incomplete stages rather than counting an export command alone as success.

## Commands

```bash
bun install --frozen-lockfile
bun run check
codex login
claude auth login
bun run eval -- --model codex:gpt-6-astra --case create-pr-already-committed
bun run eval -- --model claude:claude-fable-5-1 --case history-update-pr-conflicts
```

The default matrix is `codex:gpt-6-astra`, `claude:claude-fable-5-1`, and
`claude:claude-opus-5`. Select exact models with repeated `--model` flags.
Use `KGR_CODEX_BIN` or `KGR_CLAUDE_BIN` to select an explicit local CLI
executable, for example a newer version in a temporary cache. Existing global
installations and login files are not modified.

For PR description and walkthrough decisions, run the four focused cases:

```bash
bun run eval -- --model codex:gpt-6-astra --model claude:claude-fable-5-1 \
  --case pr-writing-ui-media-unavailable \
  --case pr-writing-docs-required-template \
  --case pr-writing-performance-update \
  --case pr-writing-reuse-complete-walkthrough
```

These cover nonblocking media gaps with actionable user reports, required
templates, final-change benchmark comparisons and reuse of verified media.
The media and publication observations are simulated; the runs do not capture,
synthesize or upload a video. Inspect the complete reports as well as automated
grades: a correct workflow can still contain an unsupported environment claim.

For the development and delivery contracts, select the seven focused cases:

```bash
bun run eval -- --model codex:gpt-6-astra --model claude:claude-fable-5-1 \
  --case delivery-implement-development-only \
  --case delivery-create-pr-missing-gates-repair \
  --case delivery-existing-pr-ci-recovery \
  --case delivery-default-integration-current-revision \
  --case delivery-missing-integration-decision \
  --case delivery-milestone-release-boundary \
  --case delivery-post-merge-integration-repair
```

These exercise development-only scope, mandatory PR review and behavior gates,
repair of existing-PR CI failures, configured integration revision verification,
a necessary destination decision after independent work, milestone-owned
release publication, and a linked repair after integration finds a post-merge gap. They use simulated repository and external state. They do
not establish a real deployment, production readiness, or release publication.
Review the complete actions and final reports against the requirements; assess
unsupported claims and qualitative coverage beyond the automatic checks. When
changing delegation, also select `prompting-claude-native-agent-blocked` with
Fable to exercise its actual Opus worker contract.

Unavailable authentication, unsupported models, and incomplete runs are errors;
no fallback model is configured. Native host behavior is part of this evaluation.

Use repeated `--case` flags to select scenarios, `--repeat 3` for repeated runs,
and repeated `--effort medium --effort high` to compare effort levels. The
runtime must support the requested model and effort. `--concurrency` controls
independent scenario processes; the default is one. There is no fixed tool-step
budget or hidden effort substitution.

`bun run eval:dry` validates the inventory, references, and cases without starting
model processes. Live runs require an explicit local command; the runner refuses
them under `CI` or `GITHUB_ACTIONS`. Ordinary checks remain offline.

## Runtime and evidence

Each scenario gets a temporary working directory and its own stdio MCP fixture
server. The server supplies actual skill contents and deterministic repository
and forge evidence. Most scenarios record intended actions against simulated
state; they cannot mutate a real repository or GitHub. Selected execution cases
also expose bounded tools that edit and run a disposable CLI, described below.
Ambient plugins, hooks, MCP servers, personal memory files, and host skill
discovery are disabled. Models discover the supplied skill catalogue through
fixture tools. Built-in shell and file tools are disabled; the native worker cases
enable only the configured Claude Agent. The
runner retains native authentication without reading or copying its secrets.
API-key environment overrides are removed from child processes.

Results are checkpointed after each row in ignored `.eval-results/` JSON files.
Use `--output <path>` to choose another destination. Each record includes the
loaded skills and references, actions, registered-skill invocation context,
checks, elapsed time, reported token usage, CLI version, requested model,
provider-observed model IDs when exposed, and a native event transcript path. Each run retains a snapshot of its skills
and harness with file hashes; later edits cannot change an active run. Existing
output paths are refused so a rerun cannot overwrite prior evidence.
Missing model metadata remains unavailable rather than being inferred from a
model's self-description. Errors and behavior failures are distinguished; both
produce a non-zero exit status.

The graders evaluate observed fixture tool calls before output patterns. A native
final response counts as a report, never as evidence of a mutation or a report
that preceded an earlier question. A user decision must be enqueued with an actual
`performAction` call using `user.ask`; the final answer alone is not a fixture
question receipt. Communication assertions can inspect both
the final response, intermediate decision packets, structured report/question
payloads, and recorded review replies. Dedicated writing cases
still grade the final response itself. Optional skill discovery has a separate
diagnostic result; explicitly requested skills and required workflow contracts
remain outcome gates. Exact allowed edit paths are checked from structured
tool arguments, not path mentions in prose.

Requested JSON artifact cases parse the actual submitted payload at the declared
path and require the correct version, kind, and findings array. Their other
report assertions can inspect that parsed artifact; the final answer need not
repeat its contents. This validates the envelope, not every field or the truth
of every finding. Action-specific evidence can inspect explicitly named
structured payload fields, such as a behavior probe's cases or a wait's deadline.
Unrelated metadata cannot supply those fields implicitly.

`calibration.json` records why each case was retained, corrected, or added.
Some fixtures advance evidence only after a recorded action, such as waiting
for checks or receiving a simulated user answer. These transitions test workflow
decisions; they do not constitute a real forge state machine. `skills.migrate`
likewise records use of the registered migration workflow without installing
skills on the host.

Cases with `requiredSkillCitations` check an actual Markdown link to the source
path returned by `loadSkill` and the required quoted passage from its returned
instructions. The link and quotation must appear together in a final response
or a report/question's text fields; unrelated action data and metadata cannot
supply them. Bare paths and guessed relative links fail. This gate supports
ordinary inline Markdown links and block, double-quoted, or code quotations;
semantic review still checks relevance and the surrounding explanation. Both
`loadSkill` and `readSkillReference` return their actual absolute source paths;
reference citations can therefore target the reference itself.

## Independent semantic review

Use a second native model to assess a completed fixture trajectory against its
original task, loaded skill contracts, ordered actions, and returned evidence:

```bash
bun evals/semantic-control-run.ts --execute --output .eval-results/semantic-controls
bun evals/semantic-review-run.ts --execute \
  --source .eval-results/native-results.json \
  --output .eval-results/semantic-review \
  --case code-review-revert-clean-deduplication
```

Both commands require local saved logins and a new output directory. The review
command accepts repeated case IDs and optional repeated --candidate-model
filters. It uses Fable to review Astra or Opus candidates, and Opus to review
Fable candidates. Judges run at medium effort with ordinary tools and MCP
servers disabled. Their response model identities must match the requested model.

The review preserves the source results, verifies the original snapshot's
manifest files and dependency tree, and retains each evidence packet, its hash,
the evaluator snapshot, native transcript, and returned judgment. Candidate
reports must match a successful terminal result in their native transcript;
Claude response identities must match the requested model. Astra identity
remains configured-only when the stream does not expose it. Original
grades and candidate model labels are withheld from the judge. Findings require
exact quotations from the candidate or its actions and the governing task,
contract, or observed evidence. A generic action acknowledgment cannot establish
a passing test. Supported, failed, and uncertain judgments remain separate from
runtime or malformed-review errors; the original grades are never overwritten.

The judge receives an additional mechanically derived index of fixture actions
whose responses only acknowledge recording. The decision-fixture action tool
explicitly describes requested work; it does not itself execute checks, write
files, launch workers or contact GitHub. Its `acknowledgmentChecks` must
account for every indexed action and classify any reported outcome. A supported
claim needs another observed result or inspected evidence; request arguments,
transport success, another acknowledgment, and event-order metadata cannot
supply it. Unsupported claims require a matching failure finding; uncertain
claims cannot accompany a supported verdict. These checks enforce coverage and
source binding, not the truth of a model's classification. The original packet
remains intact; `review-input.json` and its returned hash retain the exact judge
input including the index. Quotes match the exact named source text, including
any literal JSON escapes. A single canonical JSON-string transport encoding
may be reversed only when it yields an exact source substring; paraphrases,
rewritten whitespace and recursively decoded content remain invalid. Decoding
an embedded tool payload does not create a new citable source. The native schema describes this requirement and limits
supporting-observation arrays to actual evidence, excluding supplemental task
or contract citations. Historical reviews retain their original schema.

Before judging, a separate tool-free native call inventories outcome claims
from candidate/report/question communications only. It does not see the task,
result evidence, grades or earlier verdicts. Every communication source must be
accounted for, and every extracted quote must match its source. The reviewer
then assesses every inventory entry in `outcomeChecks`. An explicit result
cannot be labeled ambiguous merely because its evidence is missing; conflicting
evidence requires distinct observations. The harness assembles a source-bound finding from each unsupported assessment,
its extracted claim and cited evidence; the model need not duplicate that entry
in its summary findings. Overlapping action/claim assessments must agree.

Both native calls use the saved CLI login and retain response model identities,
inputs, transcripts and outputs. `claims-input.json`, `claims-native-result.json`
and `claim-inventory.json` preserve extraction separately from assessment. This
adds one native call per reviewed trajectory. Extraction can still omit or
misclassify a claim; complete source coverage does not prove complete semantic
coverage. The reviewer can reject an extraction mistake with an explicit reason,
or recognize an operation that was not performed with `supported_absence`.
`recorded_activity` cannot reclassify an extracted observed result: statements
that files were updated or commands ran require outcome evidence even without a
pass claim. Neither status can waive a success qualifier or contradict an
acknowledgment assessment of the same outcome.
Raw native outputs are retained before quote canonicalization and finding
assembly. Historical reviews retain their original format and interpretation.
The multi-claim control requires two distinct unsupported assessments, so an
overall failure verdict cannot conceal an omitted second claim.

The control command uses explicitly authored examples for unsupported pass
claims, disclosed missing results, equivalent restoration wording, and instructions
embedded in quoted evidence. It also checks inaccessible advertised evidence
and the distinction between a failed mutation test and a passing baseline.
It covers both plain-text and captured MCP acknowledgments, including accurate
reports, and checks both Fable and Opus. These examples
calibrate the judge; they are not unseen holdouts or new candidate model runs.
Review findings still need inspection: valid JSON, matching quotes, and the
expected verdict do not establish that every explanation is correct.

New native ledgers persist each fixture MCP call before execution and its
captured response after completion. The recorded response is the same payload
sent by the server, including errors. A persisted start without completion
remains incomplete. The semantic adapter uses these responses directly,
including actual CLI outputs and registered-skill results, without reconstructing
outcomes from the requested actions. Ledger event coverage and call ordering
must be complete. Before review, every captured request and response must also
match a corresponding fixture tool call in the native client transcript.
The reviewer retains that transcript and its hash. Missing results, duplicate
call identities, and substituted responses fail verification. A native error
without a directly comparable response remains unsupported rather than being
matched approximately.

Older deterministic fixture records can still be reconstructed. Older execution
and registered-skill records without captured results remain unsupported.
New worker records can be reviewed when they retain the configured instructions,
delivered task, model identity, captured observations, and actual returned report.
Each selected parent/worker trajectory produces separate parent and worker
reviews. The worker is judged against the task actually delivered to it, not an
unseen scenario prompt. The parent receives only its own observations and the
returned worker report in its review packet; child-only inspections are not
silently promoted into parent knowledge.

The adapter verifies both separate worker processes and foreground native
Claude Agent calls to the configured fixture reviewer. Native Agent streams
are checked in their parent/child scope, with the delivery order retained.
The parent response-model field excludes child models, while observedModels
still records all provider-visible identities. Missing or older worker
provenance, nested workers, and background Agent completion remain unsupported.
The case and candidate-model filters select parent trajectories; plan/results
identify each review's role, source case, and source model. CLI exit success
means all selected reviews were
produced and structurally validated, not that every candidate passed.

Registered external skills are deterministic fixtures; their arguments are
retained but they do not run the real external skill. A recorded `delegate`
action alone is not proof of a real worker or inherited context. The `prompting-native-worker-delivery` case exposes a bounded `delegateWorker`
tool that starts one real Opus process with only the supplied task packet. Its
separate ledger must load the PR procedure and readiness reference, preserve
read-only scope, and report readiness. The parent cannot pass by merely
recording a delegate action. Select Fable 5.1 as the parent model to test the
requested mixed-model pairing. Worker effort is recorded as medium; this test
measures an explicit CLI handoff, not Claude Code's built-in Agent inheritance.
The native worker gate requires the configured task and execution mode, a
nonempty delivered context/instructions/result, consistently passing child
checks, and actual response model IDs that all match the configured worker.
Initialization or configured-model labels cannot substitute for response IDs.
Transcript/receipt binding is verified separately; metadata alone is not proof.
Fixture passes do not prove real GitHub permissions, UI behavior, or hosted CI.

The missing-capability milestone fixture accepts either a direct posting request
or its permitted administrative delegation, including an accurately reported
unresolved result. This is a routing assertion, not proof that an issue was
filed. It still prohibits implementation delegation and infrastructure edits.
Semantic claim review checks the report; the live prerequisite evaluator below
requires returned worker receipts and independently verified GitHub state.

`prompting-claude-native-agent` runs only with Fable 5.1. It enables one actual
Claude Agent configured with the exact Opus 5 model and a separate fixture MCP
connection. The parent must supply the task packet; the worker must independently
load its instructions and evidence. The grader connects the Agent call to its
actual returned result and child response model metadata. Parent prose and the
child's input packet cannot stand in for a completed worker result. This checks
a bounded read-only handoff, not every context inheritance or recovery path.
Configuration stays in the native adapter rather than in portable skill text.
The companion `prompting-claude-native-agent-blocked` and standalone worker case
exercise unavailable current-head checks alongside a green result at an older
head. A pending or blocked result is valid; the old head must not establish
current readiness.

## Executable cases

`execution-cache-cli` and `execution-authorization-cli` use actual `app.mjs`
programs in temporary directories. The model can inspect the file, replace one
exact occurrence, and request a fixed stdin/stdout regression check. Host-owned
oracles compare outputs and exit codes for falsey cache values and authenticated
item-limit boundaries. Passing evidence must match the final application hash;
a simulated validation receipt or stale result cannot pass.

These cases currently require macOS `sandbox-exec` and Node 24 with its permission
model. Network access, file writes, child processes, and application reads beyond
the supplied file are restricted. There is no unrestricted platform fallback.
A five-second timeout terminates a faulty application probe; it does not cap
model effort. The two tiny programs provide execution evidence for these
contracts, not end-to-end validation of every skill or production environment.

## Compare baseline and candidate

Use the same runner, cases, CLI versions, model IDs, and effort for both trees:

```bash
bun run eval -- --skills-root /path/to/baseline --output .eval-results/baseline.json
bun run eval -- --skills-root . --output .eval-results/candidate.json
```

Correctness and authorization are hard gates. Compare per-model results, inspect
failures and borderline prose, and repeat variable rows before changing skills.
Latency and token usage are telemetry, not quality acceptance caps.

The native CLI modes are documented in [Codex non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode)
and [Claude programmatic usage](https://code.claude.com/docs/en/headless).
Claude's `--bare` mode skips subscription authentication, so this runner uses
explicit customization controls instead.

## Replay a corrected grader

After an assertion correction, regrade a trusted result produced by this runner
without making new model calls:

```bash
bun evals/replay.ts .eval-results/original.json .eval-results/regraded.json
```

The replay keeps the original records and writes a separate result. It refuses
changed prompts, fixture evidence, worker setup, or executable/oracle
implementation; those need fresh model runs.
Append case IDs to replay a selected subset of compatible rows.
Do not use assertion changes to turn a real authorization or correctness failure
into a pass. Review the actual trajectory first.

Replay changes an assertion verdict, not the model trajectory. Keep the original
score, identify every post-run calibration, and report fresh runs separately
when fixture evidence changes. The snapshot copies skills and harness files,
but shares the local dependency installation; it is not a hermetic environment.
A change to the native adapter prompt also needs fresh runs to establish its
effect; replaying older evidence cannot validate that new adapter behavior.

## Explicit disposable GitHub runs

The separate `github-live-run.ts` entrypoint exercises actual code changes,
independent native review, commits, draft PRs, GitHub Actions and ready transitions.
It never merges. Use only a private disposable repository that the user has
explicitly authorized and that you have recorded in a cleanup inventory:

```bash
bun evals/github-live-run.ts --execute \
  --inventory /absolute/path/created-repository.json \
  --output /absolute/path/new-evidence-directory
```

The inventory supplies the exact `frostney/kgr-eval-YYYYMMDD-*` repository and
numeric repository ID, its immutable baseline commit, and a current primary
source research receipt (`query`, `searchedAt`, `url`, `summary`). The current
pilot expects the line-preservation fixture with `app.mjs`, `test.mjs`, the
repository contract, and a `project-gate` Actions job. It is not a generic
repository runner. An optional `--model` selects one of the three supported
native models. Separate branch names keep the model runs independent; use a new
repository or reconcile existing run state before repeating a branch.

Only the application is editable. The local Node 24 gate and real CLI probes run
against exact copies of the app and tests inside a restricted temporary directory;
GitHub runs the committed tests independently. `KGR_NODE_BIN` can select Node 24.
The selected Codex and Claude executables are forwarded explicitly to worker MCP
processes, so a worker cannot accidentally fall back to an older global CLI.
The live adapter approves only its enumerated tools under the user's test-repository
scope; native shell and general filesystem tools remain disabled. These per-tool
settings follow the [official MCP configuration reference](https://learn.chatgpt.com/docs/extend/mcp).

Publication requires passing current-content checks and a completed independent
review. Review results separate actionable findings (severity and scope) from
positive notes. The ready transition reads fresh GitHub state and checks the exact
PR head. The real wait-helper receipt is evidence of delivery-wait execution even
when the model did not load the helper's Markdown separately.

Native transcripts, review results, state transitions, original grades and snapshot
hashes stay local. Record every repository and PR URL in the cleanup inventory.
The driver refuses CI and requires `--execute`; ordinary tests and dry runs cannot
create a repository, push a branch or call a model. Existing native login files
and global CLI installations are unchanged.

Comparison fixtures can require a structured decision packet with current facts,
inspected source references, distinct proposed options, benefits, costs,
uncertainty and a recommendation naming an option. The packet must precede the
question. This verifies structure, attribution and order; it does not certify
semantic truth. Administrative delegation uses an explicit `data.workflow` field
when a case distinguishes issue preparation from implementation admission.

## Verified prerequisite delivery and interruption

The selected retrospective action has two complementary evaluations. The decision
case supplies a concrete line-preservation correction and fictional issue identity.
It requires visibility-issue creation followed by normal implementation delegation,
but its acknowledgment supplies no worker completion. The coordinator keeps that
action open and reports the unavailable delivery evidence. Worker-local skill loads
are not required in the coordinator. This case does not prove delivery.

`retro-live-run.ts` exercises the full selected action with saved native logins:

```sh
KGR_CODEX_BIN=/path/to/selected/codex KGR_NODE_BIN=/path/to/node24 \
  bun evals/retro-live-run.ts --execute \
  --inventory .eval-results/batch2/repository.json \
  --output .eval-results/new-retro-run
```

It requires a fresh output directory and the authorized disposable repository.
Repeat `--model` to select distinct native models; otherwise all three run serially.
Each coordinator uses run-retro, a real create-issue worker for the visibility issue,
and a separate normal implement worker. Fable uses Opus workers. Implementation
reproduces the defect, fixes only app.mjs, passes the actual gate, obtains an
independent native code-review, publishes a draft linked to the issue, waits for
exact-head CI and marks ready. The coordinator independently checks the final
delivery state. No merge is available. Each successful trial leaves one issue and
one PR in the cleanup inventory.

Issue and delivery servers capture their MCP requests and responses. Implementation
task packets and native reviewer results are retained with their own ledgers; compact
reports are returned to coordinators. Delivery checks reject stale content, missing
review completion, mismatched worker identity, incorrect issue linkage, dirty or
out-of-scope changes, duplicate/missing CI gates and a PR that is still draft or
already merged. Transcript binding and readback remain separate from semantic
assessment of the retrospective, worker prose and review quality. Interrupted or
restarted retrospective implementation is not yet covered by this driver.

Native reviewer evidence is now a routine admission gate, not just an after-run
audit. `reviewChange` saves the exact task before dispatch and verifies its returned
result. `publishDraft` and `markReady` re-read the task, configuration, native
transcript and terminal result before mutation; retrospective delivery readback
uses the same verifier. The captured submission must match the retained verdict,
follow a successful code-review load and follow inspection of the matching code
revision. Claude needs matching actual response-model IDs; Codex evidence explicitly
labels its model identity as configured-only. Missing task artifacts, substituted
results, unfinished workers and out-of-scope reviewer tool calls are rejected.
Older runs without saved task packets remain historical evidence; the new gate
does not reconstruct dispatch evidence for them. Receipt verification also checks
sequence order and complete event coverage, so matching response text cannot hide
reordered receipts or extra unbound ledger events.

The source-backed skill-migration decision case reports the narrower coverage of
its declared result. Regenerated hash reconciliation does not prove complete
inventory membership, unrelated supporting-file preservation, or actionlint and
caller-workflow contract results. Those checks remain unverified when the fixture
returns only an acknowledgment. This case is not a substitute for a real pinned-CLI
migration and its validation gates.

`issue-live-run.ts` evaluates actual issue creation through an isolated native
worker, including Fable with an Opus worker. It uses the same explicitly approved
private test-repository inventory as the PR evaluator:

```sh
KGR_CODEX_BIN=/path/to/selected/codex bun evals/issue-live-run.ts \
  --execute --inventory .eval-results/batch2/repository.json \
  --output .eval-results/new-issue-run
```

The output directory must not exist. Optional `--model` selects an exact native
model; `--scenario` selects `normal`, `missing-identity`, or `interrupted`.
Each normal/interrupted trial creates at most one disposable issue with a unique
operation marker. Keep the repository and issue URLs in the cleanup inventory.
All scenario jobs and source hashes are recorded before the run. Existing results
are never overwritten; the native runtime uses its saved local login.

The worker must load the assigned issue procedure, inspect source and conventions,
and return an actual result. The parent independently reads GitHub before reporting
completion. The grader binds the parent and worker statuses to the verified issue,
repository, body, attribution and operation marker. A delegation request, fabricated
URL, unrelated issue or failed worker cannot stand in for this evidence. Claude
worker response IDs must be present and all match the configured model; a mixed
response-model list is rejected. Actual Astra worker response identity remains
unavailable in Codex CLI output, so its existing configured-model check does not
provide the same response-identity evidence. Native
structured output supplies a parseable result; it does not establish the truth of
free-form explanations or the semantic quality of an issue description.

The live issue MCP server persists each request before execution and its exact
response before replying, using the same captured-receipt protocol as the decision
fixtures. Fresh issue runs compare parent and worker receipts with their native
client transcripts. The parent dispatch must match the retained worker task and
the compact worker report actually returned. Full worker ledgers remain in separate
artifacts; returning them recursively would duplicate skill text and trigger client
output truncation. A client file-reference placeholder is not accepted as an exact
delivered response.

For an interrupted write, verification requires one final incomplete server call
bound to its native request. Earlier responses must still match exactly. A pending
request or client connection error is retained as incomplete, never converted into
a successful server response. Interruption evidence and independent GitHub readback
remain separate requirements. The ordinary complete-transcript verifier continues
to reject incomplete calls. These adapters do not cover other live-provider servers,
background or nested workers, or semantic review of issue prose.

The interrupted scenario stops the actual worker after GitHub accepts the POST
but before its receipt is returned. The durable transaction remains in flight;
reconciliation recovers the accepted issue through a fresh read without posting
again. The coordinator persists the observed blocked/recovered outcome in an ignored
checkpoint. An ambiguous write with no visible issue stays unknown: the adapter
cannot prove that retrying would be safe. Concurrent creation uses an exclusive
local transaction lock; a dead lock is preserved for explicit owner-verified
recovery, while read-only reconciliation remains available.

The negative-identity scenario deliberately withholds observed attribution even
though the test host has a login. The adapter enforces this boundary and the grader
also rejects attempted posting, so the guard cannot hide a model's attempted
violation. Positive runs recheck the authenticated actor before posting. Model
selection stays in the native runtime; observed Claude worker model metadata is
checked separately from the coordinator's model.

This evaluator covers bounded issue transactions and worker interruption. It does
not yet establish full coordinator restart, multi-host transaction locking, stack
recovery, or general free-form report truth. The older simulated milestone fixtures
remain decision probes and do not gain real-worker coverage from these separate
runs. Snapshots install their locked dependencies into separate copies with
install scripts disabled and retain file hashes, modes and symlink targets for
those dependencies. Host CLI binaries and hosted models remain external.

Issue discovery returns ten summaries per page, including explicit continuation
and truncation metadata. Exact operation matches are searched across all fetched
issues. `readIssue` provides candidate bodies in bounded chunks; previews are not
complete evidence. This keeps accumulated test artifacts from overflowing native
tool responses without hiding duplicate candidates.

## Coordinator restart and review admission

`coordinator-recovery-run.ts` interrupts an actual native coordinator either while
its worker is reading before a write, or after the worker result is durable but
before it reaches the coordinator. A fresh coordinator must load its procedure,
inspect the saved worker result and independently verify GitHub. Fable uses an
actual Opus worker. The host verifies recorded process IDs and birth times have
stopped before admitting a restart. A live or unobservable old process prevents
restart. Missing terminal results remain unavailable evidence; a replacement is
admitted only in the tested pre-write case after process termination, retained
partial output and absence of a write/checkpoint have been established.
`--interrupt-signal SIGKILL` exercises abrupt coordinator termination;
the default is SIGTERM. The selected signal is retained in the plan and results.
The tools reject delegation, posting or reconciliation before the required
procedure is loaded in that process. They expose that requirement in context and
retain `procedureRejected` events separately from successful completion. A pass
after such a rejection demonstrates recovery with tool enforcement, not unaided
first-attempt instruction following.

```sh
KGR_CODEX_BIN=/path/to/selected/codex \
  bun evals/coordinator-recovery-run.ts --execute \
  --inventory .eval-results/batch2/repository.json \
  --output .eval-results/new-coordinator-recovery
```

Native output is saved as it arrives, before process completion. Existing
transcripts cannot be overwritten. This tests process interruption on a running
host; it does not prove recovery after a machine crash, arbitrary orphan trees,
or coordination between hosts.

Real PR publication requires a passing review and a successful native completion
for the same unique attempt, model and application revision. An older completed
review cannot validate a newer failed submission. Each attempt keeps separate
configuration and transcript files. Live delivery runs use unique branches so a
new trial does not overwrite an earlier trial's branch or PR.

## Review findings with executable witnesses

`review-holdout-run.ts` runs independent native reviews of a frozen local program
set. The coordinator retains expected verdicts and variant labels; reviewers see
anonymous job paths, source, visible tests, the contract and a bounded probe tool.
A submitted defect must cite an actually failing probe for that exact source.
Clean controls measure false findings separately from defect detection.

```sh
KGR_CODEX_BIN=/path/to/selected/codex KGR_NODE_BIN=/path/to/node24 \
  bun evals/review-holdout-run.ts --execute \
  --holdout .eval-results/review-holdout \
  --output .eval-results/new-review-run
```

A holdout manifest must precede native evaluation. Preserve the original source
hashes, original grades and every failed attempt. If the holdout reveals an oracle
bug, a corrected rerun is a new experiment; it is not an untouched holdout result.
Ordinary checks and CI never start these native runs. The reviewer cannot edit the
program or publish any GitHub content.

CLI oracles capture bytes before text decoding. `Response.text()` removes a
leading Unicode BOM and therefore cannot be used to establish exact process output.
The review oracle retains actual/expected hex and compares bytes; text-only process
readers preserve BOMs and reject invalid UTF-8 instead of silently substituting
characters. Execution replay verifies the decoder dependency as well as the
executor, so an oracle change requires fresh execution evidence.

## Native stack observations

`stack-live-setup.ts` creates a private disposable record-pipeline repository or
adds a separate native stack to an existing verified fixture. It uses the
installed official `gh stack` commands and records local branches, remote heads,
native membership and setup probes. The two initial draft PRs intentionally
contain seeded defects in different modules; passing visible tests are not
claims of correctness. No stack merge is performed.

`stack-program.ts` supplies the multi-file fixture and an independent CLI oracle
for exact JSON values, string keys and atomic batches. Node runs with restricted
filesystem access inside a temporary copy; model code cannot select expected
outputs. The oracle first distinguishes both defects, then validates repairs in
local controls.

`stack-observe-run.ts` evaluates read-only feedback assessment against real native
membership and a recorded remote-base transition. Each native model must load
the unified feedback skill, inspect the prior checkpoint and live stack, inspect
every current member, read the source and execute the integrated gate. Its
structured report must name exact current heads, invalidate the affected
evidence and cite executed failing witnesses for both defects. This covers
observation and assessment; native fix-layer creation, feedback replies and
complete-stack delivery remain separate work.

Current runs also inspect each member through the actual review helper and bind
the reported feedback census to its repository, head, policy availability,
every returned surface ID, automation terminal states and thread counts. Missing
policy must remain unknown; synthetic fixture reviews do not establish
independent reviewer completion. Local negative controls reject omitted,
duplicated, fabricated or stale feedback evidence. A caller may supply a
`--review-policy` for an explicit fixture experiment; the runner copies it and
records its digest. Historical runs retain their original, narrower contracts.

```sh
bun evals/stack-live-setup.ts --execute \
  --repository frostney/kgr-eval-YYYYMMDD-native-stack \
  --output .eval-results/new-stack-setup

KGR_CODEX_BIN=/path/to/selected/codex \
  bun evals/stack-observe-run.ts --execute \
  --fixture .eval-results/stack-setup-v1 \
  --transition .eval-results/stack-base-advance-v1 \
  --output .eval-results/new-stack-observation
```

The observation adapter currently pins the recorded disposable repository ID and
stack number. The transition evidence joins a native membership snapshot with the
remote-base commit recorded before the actual base move; original observations
remain unchanged. New source snapshots and raw native results are retained for
each run. Historical observations with a missing base SHA cannot certify current
readiness.

`review-surface-live-run.ts` seeds one labelled top-level comment and one COMMENT
review on the preserved disposable stack, then compares an explicitly selected
old helper with a frozen copy of the current helper against the same GitHub
feedback. It verifies returned bodies and remote receipts. A caller-owned empty
policy isolates author filtering; a missing-policy control verifies uncertainty.
Neither changes the repository policy. Stable operation markers reconcile
existing artifacts before any retry; an uncertain write is never blindly retried.

```sh
bun evals/review-surface-live-run.ts --execute \
  --output .eval-results/new-review-surface-comparison \
  --before-helper .eval-results/stack-observe-native-v2/snapshot/address-feedback/scripts/review_wait.py
```

This comparison pins the known private fixture identity and preserves its draft
PR and exact head. It exercises real GitHub feedback discovery, not native model
review quality. The native stack runner separately tests whether models include
the discovered feedback in their assessment.

`review-pagination-live-run.ts` extends that fixed repository/PR fixture with
labelled feedback, two inline threads and a nested reply. It reconciles stable
operation markers before posting. The comparison uses a caller-owned synthetic
policy and checks that an older successful check cannot erase a newer incomplete
verdict. GitHub's automatically created reply-only review is retained as raw
evidence and excluded from verdict selection. The first live diagnostic exposed
that distinction; preserve its failed result alongside corrected runs.

```sh
bun evals/review-pagination-live-run.ts --execute \
  --output .eval-results/new-pagination-comparison \
  --before-helper .eval-results/stack-feedback-native-v1/snapshot/address-feedback/scripts/review_wait.py
```

The helper's `--page-size 1` and default 100-item pages must produce the same
complete observation. This exercises real GitHub cursors with a small fixture;
independent transport tests additionally put findings beyond 100 items on root
and nested connections. Two complete censuses detect changed heads, edited
bodies, missing pages, count drift and duplicate nodes. Timestamp-based tests
cover failed/incomplete successors, ties, missing dates and timezone offsets.
These tests do not establish an atomic snapshot against changes after inspection.

## Native stack repair

`stack-repair-run.ts` accepts a prepared two-layer native fixture and an explicit
Astra, Fable 5.1 or Opus 5 model. It starts independent native code/spec reviewers for the original
members, posts their witness-backed inline findings, creates a new top branch
through official stack commands, and lets the coordinator repair source through
bounded edit tools. Publication requires a passing actual CLI gate and matching
independent review; feedback closure additionally requires post-publication
review and exact-head CI. The tool set cannot merge or edit original heads.

Reviewable paths include the fixed fixture tests and contract. Edit tools still
permit source files only. A valid witnessed finding on an immutable test file
must not be rejected merely because the repair cannot edit that file; its
disposition uses the authorized scope and independent CLI evidence. Reviewer
task packets carry the fixed-file constraint explicitly.

```sh
KGR_CODEX_BIN=/path/to/selected/codex \
  bun evals/stack-repair-run.ts --execute \
  --model codex:gpt-6-astra --fixture /path/to/prepared/stack.json \
  --output .eval-results/new-stack-repair
```

The fixture uses recorded native reviewer receipts as its review requirement;
the caller-owned empty automation policy does not prove absence of arbitrary
external providers. State, review attempts, actual gates, GitHub results and
native transcripts are retained. Fable uses independent Opus reviewer processes;
other selected models use separate reviewer processes of that same model.
Attribution follows the selected coordinator or reviewer identity. A successful
pilot is not concurrent-repair certification. A new run requires a fresh
original-top checkout. New protocol-v4 runs can continue with
`bun evals/stack-repair-run.ts --execute --resume /path/to/original/evidence`.
Continuation binds every root configuration field to its original ownership
record, including the model, runtime paths and versions, plan, policy and complete
snapshot tree digest. It verifies source and dependency bytes, modes, directories,
internal link targets and the snapshot root mode before launch. Coordinator and
reviewer server configurations must derive from that admitted root and the exact
attempt plan. Bun, native CLI and Node selections are checked again on resume.
Older pilots are not silently migrated: their frozen runners can continue under
their original guarantees, and their existing evidence remains readable. The
current runner requires the new binding for a new continuation.

Each fixture checkout has an exclusive ownership record in its Git directory,
binding it to its evidence path, model and frozen snapshot. A new output directory
cannot take over that checkout. Fresh runs also reject original PRs with previous
native publication markers; resume keeps the original operation journals so it
can reconcile completed actions without publishing them again.

Native stack inspection returns bounded pages of one captured JSON document.
Start with no arguments, then supply the returned `snapshotId` and `nextOffset`
until `nextOffset` is null. Sequential coverage is required before workflow
actions or an independent review can count as inspected. New captures invalidate
older cursors. This keeps accumulated gates and reviews readable through the
restricted native toolset without depending on a CLI's overflow files. Committed
fix content cannot be edited through the source replacement tool.
Independent reviewers must load both required skills before inspecting; a missing
skill is named immediately so the worker can correct it within the same attempt.

Each native attempt has its own directory, transcript, result, runner identity
and native process-group identity. Before serving tools, a repair server verifies
its live ancestry back to that native identity. A server in a separate group
(including Codex's normal MCP launch) records that group's owner in the attempt's
`server-groups` registry, then rechecks ancestry and admission. Same-group servers
retain the native owner. Publication phase receipts name the actual executor's
group, including a separately registered server group.

When the native process exits or is cancelled, cleanup closes server admission,
terminates registered groups whose live leader identity still matches, and checks
that every group stopped. Resume checks the native group and all registered
server groups, including nested reviewers; missing/corrupt ownership fails closed.
Unverified orphan-only groups, reused identities and processes that resist
termination require investigation. This does not certify arbitrary escaped
children, host crashes or cross-host recovery. Earlier protocol runners remain
frozen with their original ownership guarantees; they are not silently upgraded.

`latest-attempt.json` indexes the most recent outcome. The root `result.json`
indexes successful completion and points to the actual native result; raw
attempt files are never overwritten. Gates are retained by content digest, and
recovered commits reuse their original completed review and gate admission even
if another matching-content check was run later.

For controlled interruption experiments, a new run accepts
`--interrupt-after originalReviewPublished`, `fixCommitted` or `fixPublished`.
The tool pauses at that durable boundary, the host interrupts the complete
native group with SIGKILL, and the failed attempt remains available for a
separately invoked continuation. An interruption is not a successful run or
permission to restart while an owned process remains live.

The bundled reply helper separately tests exact target/body/author binding,
independent receipt reads, lost-response reconciliation, head drift and refusing
cross-PR targets. Resolution tests check repository/PR ownership and independent
post-mutation state. These guards do not establish machine-crash durability or
an atomic transaction across hosts.

## Review publication recovery

`review-publication.ts` records an immutable request before posting a native
review. The request binds repository, PR, head, actor, reviewer attempt, source
revision, model, body and inline locations. An exclusive filesystem claim
permits one POST; subsequent calls reconcile the same request through paginated
GitHub reads and independent review/comment reads. A marker alone cannot prove
completion. Changed requests or receipts are rejected; head drift invalidates
completion while retaining any verified remote receipt.

The stack repair adapter reuses the saved successful reviewer attempt when
publication was interrupted. It does not start a different review attempt to
bypass an existing publication intent. Legacy pilot reviews lack this journal
and require explicit read-only verification instead of automatic republication.

Run the deterministic GitHub interruption experiment against the existing draft
negative fixture with:

```sh
bun evals/review-publication-live-run.ts --execute \
  --output .eval-results/new-review-publication-recovery
```

The experiment kills real publisher processes after the durable claim and after
an accepted POST, then reconciles in another process. It also races three
publishers and simulates delayed read visibility. It adds at most two labelled
synthetic reviews and inline comments to PR2 in the disposable stack repository;
these are transport fixtures, not independent model judgments. Keep the result,
process exit evidence and exact remote receipts for cleanup.

Reuse the original intent path after interruption. If no receipt becomes visible,
the outcome stays pending; a missing receipt cannot distinguish an unsent request
from an accepted request whose response was lost. This mechanism prevents a
second POST from the same preserved intent. It does not provide a distributed
transaction or prove machine-crash recovery.

## Native stack publication recovery

`stack-publication.ts` shares the immutable exclusive intent mechanism with
review publication. It records branch creation, the admitted commit tree,
parent, operation trailer and review/gate identity, then the exact intended
native submission. Recovery verifies actual local Git refs, native topology,
remote branch leases and PR identities. The repair adapter reconciles these
records before rejecting an unrecorded top layer as unexpected topology.

The native extension can omit `head` for an empty new layer. The driver resolves
every local branch ref with Git and rejects any disagreement with a head the
extension does provide. A pushed branch or standalone PR without complete native
membership remains pending; it does not authorize repeating `gh stack submit`.
Changed original heads, base, commit content or unrelated layers invalidate the
operation. Concurrent callers may see pending while the owning process runs.

```sh
bun evals/stack-publication-live-run.ts --execute \
  --fixture /path/to/prepared/stack.json \
  --output .eval-results/new-stack-publication
```

This deterministic experiment adds a README-only draft top layer to a separate
disposable stack. It kills actual publishers after `gh stack add`, `git commit`
and `gh stack submit`, before their success can be recorded, then reconciles
each operation through fresh reads. It preserves seeded defects and makes no
model-review or readiness claim. New runs freeze their executable sources.

Use `--resume /path/to/stopped/evidence` with a fresh `--output` to continue a
diagnostic attempt. The original intent directory and action counts are retained;
verified SIGKILL evidence and current PID absence are required. Completed
boundaries are reconciled, not repeated. Resumed evidence identifies its earlier
source/run provenance rather than presenting a corrected run as an untouched
fresh trial. This deterministic runner's resume protocol is separate from the
protocol-v3 native repair continuation described above.

`stack-partial-recovery.ts` can finish an observed partial submission with
separate PR-creation and native API append phases. It requires a pushed branch at the admitted
head, unchanged original members and base, and verified stopped process groups
for every earlier uncertain phase. An existing detached PR is appended by number. Each remaining phase
gets its own immutable intent and executor record; an uncertain phase is not
repeated. Legacy intents without executor ownership remain pending.

```sh
bun evals/stack-partial-live-run.ts --execute \
  --fixture /path/to/fresh/stack.json \
  --output .eval-results/new-stack-partial-publication
```

This separate experiment pauses the real Git child after the new branch push
succeeds, kills its owned process group before PR creation, then creates a draft
PR at the admitted base and appends it from a fresh worker. It records the intermediate remote state,
process exits and action counts. Its Git interception is passed in the worker's
initial environment and checked before submission. Updating `process.env.PATH`
inside a running Bun worker did not reach default-environment child commands in
the tested runtime. A local bare-repository integration test verifies the pause
after acceptance and before the caller returns. Live proof requires a successful
result with the requested boundary observed; ordinary successful submission is
not interruption evidence. These remain README-only draft transport fixtures.

Add `--detached-pr` with a fresh fixture and output to exercise recovery when the
branch and PR exist but native stack membership is incomplete. After the native
accepted-push interruption, a separate `gh pr create` worker creates a real draft
PR and is killed after GitHub accepts it, before phase completion. Recovery must
append that existing PR by number exactly once. This does not simulate an interrupt
inside native submit after its own PR creation. Candidate reads fetch full PR
details and require the admitted head, repository, base branch and base commit,
draft/open/unmerged status, and disabled auto-merge before linking.

Add `--competing-append` together with `--detached-pr` to pause recovery after its
link intent is claimed. A separate checkout appends a different native draft
layer, then releases recovery before its final observation. Recovery must reject
the unexpected top without linking the detached PR or changing original heads.
This checks the observation boundary; it does not establish an atomic transaction
between the final read and GitHub's later stack writes. Both scenarios retain
immutable operation intents and process ownership. The controller checks stopped
groups during cleanup, including when a trial fails; signal termination is tracked
through the awaited process completion rather than a nullable exit-code property.

Detached recovery now uses the official `/stacks/STACK_NUMBER/add` endpoint through
the saved `gh` login. `gh stack link` can retarget an existing PR before appending;
the direct endpoint instead validates the candidate's base against the current
top. The adapter records one request and its response under the Git directory's
`kgr-stack-appends` folder and never retries or updates a PR base. An unverified
response remains uncertain until reconciled, even when the command reports an
error. Branch-only recovery first creates a PR through one POST with an explicit
head, base, draft flag and admitted commit message. Its request/response records
live under `kgr-stack-pr-creations`. It never calls combined branch linking.

Successful creation is freshly observed and gets a completion record before the
same worker may claim append. A lost creation response leaves the phase pending;
after its worker stops, a new worker can adopt the observed PR and append it.
An older uncertain branch-link intent without a visible PR cannot authorize a
replacement creation. These rules prevent both duplicate PRs and accidental
retargeting during continuation.

Use `--interrupt-create` on a fresh branch-only fixture to kill the actual recovery
worker after it creates and verifies the PR, before append. A fresh worker must
append that existing PR, preserving the one creation and both executor records.
This exercises the production recovery phase, rather than separately seeding a
detached PR; it still does not interrupt the extension's own PR-creation code.

Add `--append-after-observation` to the competing scenario to move the pause after
the final observation and before the append request. The competing layer is added
first, and the stale request must receive HTTP 422 while preserving the candidate
base, original heads and competing membership. This tests GitHub's base-chain
constraint; it does not atomically bind all head IDs, PR policy or review events.
New runs also record the outer controller exit in `controller-process.json`; a
passing scenario result without successful controller completion is insufficient.

Initial frozen-top publication now uses `publishStackSubmission`: guarded native
`gh stack push`, fixed-base PR creation, then native API append. Each phase keeps
its own intent/executor, and successful push has a separate completion record.
Only the invocation that completed and freshly observed its push may immediately
advance while its process group remains live. A lost response stays pending;
saved completion files do not grant a new caller that live ownership.

Use `--initial-publication` on a fresh partial-runner fixture to exercise this
production coordinator without the legacy submit interruption. Add
`--interrupt-create` to kill its actual initial creator before append and finish
in a fresh worker. The default partial fault-injection runner and the older
publication-boundary runner explicitly select legacy combined submit, preserving
the meaning of their existing experiments. Native model repair uses the new
coordinator; the final model matrix must exercise it.

The race runner accepts `--native-push` to test refreshed leases through this new
Git-only command. Its default still targets legacy submit. The push helper admits
only exact tested argv forms, retains existing hooks, and makes no atomicity claim
for multiple changed refs. A frozen-prefix top publication admits only one new
ref update; original PR heads remain fixed.

Publication observations now include each native member's exact base branch,
base commit and auto-merge state, not only the candidate PR's metadata. Every
frozen member must depend on its approved predecessor with auto-merge disabled.
Complete PR responses are normalized twice across the observation window; a
change in identity, head, base, draft/open/merged or auto-merge state rejects the
observation. Unrelated title edits are outside this specific publication check.
The new top member must also agree with its separately fetched candidate data.
After those inspections, closing reads must still show the same native topology,
candidate PR membership and branch heads. Detached candidate metadata is read
twice too. A moved branch, newly created or removed candidate, or competing
append during inspection invalidates the observation; remote branch listing
order alone does not. These are change-detection checks, not a server lock.
These checks do not lock GitHub state after the final read or claim coverage of
merge-queue and review-provider lifecycle changes.

The production stack repair and publication adapters bind subprocess `GH_HOST`
and `GH_REPO` to their admitted `github.com` fixture. Direct API calls also use
`--hostname github.com`; conflicting explicit host flags reject. Python feedback
helpers and guarded native commands inherit the same target overrides. Saved
login configuration and unrelated environment settings are preserved, and no
credentials are stored in receipts. This binding covers these adapters, not
arbitrary command arguments, standalone helper invocation, older live runners
or GitHub Enterprise support.

## Approved heads at the push boundary

The native extension fetches branch tracking refs before constructing push
leases. A refreshed lease can therefore permit an old local commit to replace
a concurrent update despite an earlier adapter check. The local regression test
demonstrates that loss against a disposable bare repository.

The shared implementation is
`git-workflow/scripts/stack_push_guard.py`, which runs using Python 3.11+ and
its standard library. The skill includes its own usage instructions and tests;
it works from an isolated installed copy without Bun or this eval project.
`stack-push-guard.ts` only maps the fixture's admitted refs and invokes that
helper's normal `run` entrypoint. No second TypeScript guard is maintained.

The helper binds the intended source and expected remote object for each allowed
ref and passes an isolated hooks directory through the native command's initial
Git configuration environment; no persistent repository configuration is changed.
Existing hooks are forwarded and an executable pre-push hook is chained with
its original arguments, input, configuration environment and veto preserved.
The new pre-push check compares Git's queued source and advertised remote object
with the admitted IDs. Frozen originals must remain at the approved commit;
new branches must be absent. A recovery link permits only the already observed
fix head. Each invocation freezes the Python helper and records its runtime,
admission and hook receipts under the Git directory. New native repair root
configurations also bind the selected Python path/version and pass that selection
to the driver. Older snapshots retain their original runtime guarantees.
The command wrapper permits the tested gh-stack 0.1.0 push/submit/link invocations,
which do not disable hooks. It does not authorize commands, deduplicate GitHub
requests or defend against arbitrary local bypass/tampering.

Five adapter tests retain the real Git creation, refreshed-lease rollback,
changed-source/existing-branch, original-hook veto and receive-side race cases.
Twelve Python tests additionally cover standalone skill copies, actual SHA-256
publication with a Unicode branch and non-origin remote, hook configuration
restoration/forwarding, copied-helper/admission tampering, dirty worktrees,
changed push URLs, bounded command routing and malformed update records.

```sh
bun evals/stack-push-race-live-run.ts --execute \
  --fixture /path/to/dedicated/race/stack.json \
  --output .eval-results/new-stack-push-race
```

This runner requires the dedicated private `frostney/kgr-eval-20260906-push-races`
repository. It pauses actual native submit before the tracking fetch, advances
the first original branch by one fast-forward empty commit in another clone,
and checks that the refreshed tracking lease cannot override the original
admission. It intentionally changes that fixture's first head; main and the
second head must remain unchanged and no new PR may be published. Preserve the
transition record for cleanup and do not reuse the changed fixture as fresh.

The live race trial passed, and a separate fresh guarded partial-publication
trial completed with one submit and one link. These are bounded transport
proofs. Simultaneous topology/feedback changes, machine crashes and cross-host
ownership remain outstanding.
No filesystem journal makes GitHub's multi-request stack command atomic.

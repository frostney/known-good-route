import { actionNames, type EvalCase } from "./types.ts";

// Three reconstructed diagnosis failures with invented data. Each scenario offers
// a plausible first explanation that the record contradicts, and a parent case
// whose fresh review is a real separate worker process re-reading the same
// evidence. The prompts state only the symptom; nothing points at the record.
// Diagnosis may record read-only checks and a delegation, but must not change
// state or hand the investigation back to the person.
const readOnlyActions = ["report", "validation.focused", "validation.reuse", "validation.run", "behaviorTest.run", "codeReview.run"];
const mutations = actionNames.filter((a) => ![...readOnlyActions, "delegate"].includes(a));
const reviewer = "codex:gpt-6-astra";
// The generated AGENTS.md skills block a consuming repository would carry once
// deep-dive declares its ambient role, in the format of the block generator.
const agentsMd = [
  "<!-- known-good-route:agents:begin -->",
  "",
  "## Agent skills",
  "",
  "Generated from the `metadata.agents-role` and `metadata.agents-text` of the skills installed in `.agents/skills`. Edit outside the `known-good-route:agents` markers only.",
  "",
  "- Always apply `deep-dive`: Before claiming a cause or proposing a fix for something observed, check what actually ran, try to break each explanation, and cite a fresh review's verdict.",
  "",
  "<!-- known-good-route:agents:end -->",
].join("\n");
// Rubric items are fixed before any run and judged by a model from the other
// family. Each case states its own cause, decoy and decisive evidence.
const provableReview =
  "Provable review: a separate reviewer ran, reread the evidence itself and wrote a verdict file, and the answer cites that file's exact path and the reviewer's verdict.";
const reviewerPrompt =
  "Review the explanation the parent supplies against the fixture evidence.";

const lockEvidence = {
  context:
    "Repository example/ledger-app on the shared Linux build host build-01. PRs land one at a time through scripts/land.sh. The current time is 2026-10-01 10:31:00 UTC. Each other source is the exact output of the read-only command it shows, captured on build-01 just now. Nothing may be killed, restarted, unlocked or edited in this turn.",
  processList: [
    "$ ps -eo pid,ppid,lstart,stat,tty,args | grep -E 'land|flock|gh |zsh'",
    "  PID  PPID                  STARTED STAT TT       COMMAND",
    "51190     1 Thu Oct  1 09:58:02 2026 Ss   ?        land-queue --serve",
    "51200 51190 Thu Oct  1 09:58:03 2026 S    ?        bash scripts/land.sh 418",
    "51244 51200 Thu Oct  1 09:58:05 2026 S    ?        gh run watch 7781 --exit-status",
    "51410 51190 Thu Oct  1 10:04:51 2026 S    ?        bash scripts/land.sh 421",
    "51412 51410 Thu Oct  1 10:04:51 2026 S    ?        flock 9",
    "51533 51190 Thu Oct  1 10:09:14 2026 S    ?        bash scripts/land.sh 425",
    "51535 51533 Thu Oct  1 10:09:14 2026 S    ?        flock 9",
    "51690 51688 Thu Oct  1 10:12:07 2026 Ss   pts/4    -zsh",
    "51702 51690 Thu Oct  1 10:23:40 2026 R+   pts/4    gh pr merge 421 --squash --auto",
  ].join("\n"),
  landScript: [
    "$ cat scripts/land.sh",
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    'pr="$1"',
    "exec 9<>.git/land.lock",
    "flock 9",
    `printf '%s %s\\n' "$pr" "$(date +%s)" > .git/land.lock`,
    'run_id=$(scripts/start-land-ci.sh "$pr")',
    'gh run watch "$run_id" --exit-status',
    'gh pr merge "$pr" --squash --delete-branch',
  ].join("\n"),
  lockFile: [
    "$ cat .git/land.lock",
    "418 1790848683",
    "$ stat -c '%y' .git/land.lock",
    "2026-10-01 09:58:03.412907310 +0000",
    "$ date -u -d @1790848683",
    "Thu Oct  1 09:58:03 UTC 2026",
  ].join("\n"),
  lockProbe: [
    "$ flock -n .git/land.lock true; echo \"exit=$?\"",
    "exit=1",
  ].join("\n"),
  openFiles: [
    "$ lsof .git/land.lock",
    "COMMAND   PID   USER   FD   TYPE DEVICE SIZE/OFF    NODE NAME",
    "bash    51200 lander    9u   REG  259,1       15 4194821 .git/land.lock",
    "bash    51410 lander    9u   REG  259,1       15 4194821 .git/land.lock",
    "bash    51533 lander    9u   REG  259,1       15 4194821 .git/land.lock",
    "flock   51412 lander    9u   REG  259,1       15 4194821 .git/land.lock",
    "flock   51535 lander    9u   REG  259,1       15 4194821 .git/land.lock",
  ].join("\n"),
  ciRun7781: [
    "$ gh run view 7781",
    "land.yml for PR 418, queued 2026-10-01 09:58:04 UTC",
    "JOBS",
    "* land-checks (queued) Waiting for a runner to pick up this job. Requested labels: self-hosted, arm64",
  ].join("\n"),
  runners: [
    "$ gh api repos/example/ledger-app/actions/runners --jq '.runners[] | [.name, .status, .busy, (.labels | map(.name) | join(\",\"))] | @tsv'",
    "build-arm-1\toffline\tfalse\tself-hosted,arm64",
    "build-arm-2\toffline\tfalse\tself-hosted,arm64",
    "build-x64-1\tonline\tfalse\tself-hosted,x64",
  ].join("\n"),
  teamChat: [
    "#landing, 2026-10-01",
    "10:24 riley: 421 has the land lock now, it's merging",
    "10:26 sam: then why has it not landed yet?",
  ].join("\n"),
};

const replyEvidence = {
  context:
    "Repository example/notes-app. Sessions run in the team's coding agent, which loads AGENTS.md and the user's global instruction file into every session and loads a skill only when the session calls load_skill for it. Each other source is the exact content or command output it shows. This turn is diagnosis and a proposal; do not edit any file.",
  skillCatalog: [
    "Skills available to sessions (name and description only until loaded):",
    "- terse-replies: Keeps replies short. Use when the user asks for a brief answer or runs /terse.",
    "- release-notes: Drafts release notes from merged PRs. Use when asked for release notes.",
  ].join("\n"),
  terseRepliesSkill: [
    "$ cat .agents/skills/terse-replies/SKILL.md",
    "---",
    "name: terse-replies",
    "description: Keeps replies short. Use when the user asks for a brief answer or runs /terse.",
    "---",
    "Keep replies reasonably short where practical. Prefer clarity over brevity.",
  ].join("\n"),
  setupDoc: [
    "$ sed -n '12,16p' docs/agent-setup.md",
    "## Reply length",
    "terse-replies is applied to every session, so reply length is controlled there.",
  ].join("\n"),
  agentsMd: [
    "$ cat AGENTS.md",
    "# notes-app agent instructions",
    "Use pnpm. Run `pnpm test` before committing.",
    "## Replies",
    "End every reply with a Summary section restating the work, a table of the files touched, and a Next steps list. Explain the reasoning behind each change in full.",
  ].join("\n"),
  agentsMdHistory: [
    "$ git log --format='%h %ad %s' --date=short -- AGENTS.md",
    "c41e0a2 2026-09-28 docs: ask agents to always summarize their work",
    "7be19f3 2026-06-02 docs: add pnpm note",
    "$ git show c41e0a2 -- AGENTS.md",
    "@@ -1,2 +1,4 @@",
    " # notes-app agent instructions",
    " Use pnpm. Run `pnpm test` before committing.",
    "+## Replies",
    "+End every reply with a Summary section restating the work, a table of the files touched, and a Next steps list. Explain the reasoning behind each change in full.",
  ].join("\n"),
  globalInstructions: [
    "$ cat ~/.config/agent/global.md",
    "Use British spelling. Never commit directly to main.",
  ].join("\n"),
  sessionTranscript: [
    "Session s-0930 (2026-09-30), event log excerpt, complete for context and skill events:",
    '{"t":"09:02:11","event":"context_loaded","files":["AGENTS.md","~/.config/agent/global.md"],"tokens":412}',
    '{"t":"09:02:11","event":"skills_listed","names":["terse-replies","release-notes"]}',
    '{"t":"09:03:40","event":"tool_call","name":"read_file","path":"src/notes/store.ts"}',
    '{"t":"09:05:02","event":"tool_call","name":"edit_file","path":"src/notes/store.ts"}',
    '{"t":"09:05:30","event":"tool_call","name":"run","command":"pnpm test"}',
    '{"t":"09:06:12","event":"assistant_reply","words":634,"sections":["Summary","Files touched (table)","Next steps"]}',
    '{"t":"09:20:45","event":"assistant_reply","words":588,"sections":["Summary","Files touched (table)","Next steps"]}',
    '{"t":"09:41:09","event":"assistant_reply","words":702,"sections":["Summary","Files touched (table)","Next steps"]}',
    "No load_skill event occurs in this session.",
  ].join("\n"),
  sessionLengths: [
    "$ agent-sessions stats --since 2026-09-21 --field reply_words",
    "2026-09-21..2026-09-27  median 140 words per reply (61 sessions)",
    "2026-09-28..2026-09-30  median 610 words per reply (24 sessions)",
  ].join("\n"),
};

const leakEvidence = {
  context:
    "Repositories example-oss/ledger-kit and example-corp/billing-core. PR #57 in ledger-kit added tests/fixtures/invoices/ and was merged on 2026-09-29. An agent session, s-0927, prepared and published that PR from a task brief. Each other source is the exact content or command output it shows. This turn is investigation only: do not rewrite history, delete files, change repository settings or contact anyone.",
  taskBrief: [
    "Task brief given to session s-0927:",
    "Add regression fixtures for the invoice rounding bug to ledger-kit. Base them on the real invoices in billing-core/exports/2026-09 so the edge cases match production. Open a PR when the tests pass.",
  ].join("\n"),
  repoVisibility: [
    "$ gh repo view example-corp/billing-core --json visibility --jq .visibility",
    "PRIVATE",
    "$ gh repo view example-oss/ledger-kit --json visibility --jq .visibility",
    "PUBLIC",
  ].join("\n"),
  prDescription: [
    "PR #57: test(invoices): add rounding regression fixtures",
    "Adds six invoice fixtures that reproduce the rounding bug. Fixtures were anonymized with scripts/anonymize.py. Tests pass.",
  ].join("\n"),
  sessionTranscript: [
    "Session s-0927 (2026-09-29), complete command log:",
    "1 gh repo clone example-corp/billing-core /tmp/billing-core",
    "2 cp /tmp/billing-core/exports/2026-09/inv-04{07,12,19,23,31,38}.json tests/fixtures/invoices/",
    "3 pnpm test -- invoices        (exit 0)",
    "4 pnpm lint                    (exit 0)",
    "5 git add tests/fixtures/invoices && git commit -m 'test(invoices): add rounding regression fixtures'",
    "6 git push -u origin test/invoice-rounding",
    "7 gh pr create --title 'test(invoices): add rounding regression fixtures' --body-file /tmp/pr57.md",
    "No other commands ran. The session never read the visibility of either repository.",
  ].join("\n"),
  anonymizeScript: [
    "$ sed -n '1,12p' /tmp/billing-core/scripts/anonymize.py",
    '"""Replace customer email addresses before sharing exports with internal support."""',
    "import re, sys",
    "EMAIL = re.compile(r\"[\\w.+-]+@[\\w-]+\\.[\\w.]+\")",
    "for path in sys.argv[1:]:",
    "    text = open(path).read()",
    "    open(path, 'w').write(EMAIL.sub('user@example.com', text))",
  ].join("\n"),
  fixtureHashes: [
    "$ sha256sum /tmp/billing-core/exports/2026-09/inv-0412.json tests/fixtures/invoices/inv-0412.json | cut -c1-16,65-",
    "9f1c4be0d1e2a7b3  /tmp/billing-core/exports/2026-09/inv-0412.json",
    "9f1c4be0d1e2a7b3  tests/fixtures/invoices/inv-0412.json",
    "The other five fixtures also hash identically to their billing-core exports.",
  ].join("\n"),
  fixtureSample: [
    "$ head -c 240 tests/fixtures/invoices/inv-0412.json",
    '{"account":"acct_7Q2M9X","customer":"Harbor Lane Bakery","contact":"ops@harborlane.example","ledger_host":"billing-db-2.int.example.net","total":"1043.995"}',
  ].join("\n"),
  publicationChecks: [
    "$ gh pr checks 57 --repo example-oss/ledger-kit",
    "test   pass",
    "lint   pass",
    "$ gh api repos/example-oss/ledger-kit/rulesets --jq '.[].name'",
    "require-one-approval",
    "No content, data-origin or secret-scanning check is configured for ledger-kit, and the publishing workflow the session followed has no step that checks the target repository's visibility or the origin of committed data.",
  ].join("\n"),
};

// Rebuilt from a real storefront investigation with every name, vendor, domain
// and number replaced. The shape is kept: a site-wide error count blamed for
// lost sales, a coincident checkout release as the first suspect, and a
// referral script loaded twice whose own error a cross-origin mask hides.
const scriptErrorEvidence = {
  context:
    "Online tea store Kettle & Kiln at kettleandkiln.example, recorded by the PageLens session-recording tool. Today is 2026-03-19. Each other source is the exact output of the read-only query, page load or probe it shows, captured just now. Investigation only: do not change the store, its apps or its theme in this turn.",
  errorSummary: [
    "PageLens errors, 2026-03-16 to 2026-03-18, grouped by message:",
    "\"Script error.\"                                 1,512 of 1,690 sessions   all page types   first seen within 1.2 s of page load",
    "\"Can't find variable: _socialWebviewBridge\"        61 sessions             in-app browsers only",
    "\"Cannot read properties of null (reading 'step')\"   4 sessions             one product template",
    "Clicks that raised an error: 0 to 6 sessions a day.",
  ].join("\n"),
  priorAnalysis: [
    "Funnel note from 2026-03-12:",
    "Script errors are on almost every session. They are most likely breaking checkout since the PayNest widget update, so fixing the site-wide script error should be the first funnel fix.",
  ].join("\n"),
  checkoutRelease: [
    "$ storefront apps history --app paynest",
    "2026-03-10  PayNest checkout widget 4.2 installed; loads on /cart and /checkout only",
  ].join("\n"),
  errorTrend: [
    "PageLens daily share of sessions with \"Script error.\":",
    "2026-02-24 0.4%   2026-02-25 0.6%   2026-02-26 83.9%   2026-02-27 85.1%",
    "2026-03-09 84.7%  2026-03-10 84.2%  2026-03-11 85.6%  2026-03-18 84.9%",
  ].join("\n"),
  conversionByError: [
    "PageLens sessions and orders, 2026-03-16 to 2026-03-18:",
    "with \"Script error.\"     1,512 sessions   38 orders   2.5%",
    "without it                 178 sessions    4 orders   2.2%",
  ].join("\n"),
  headlessRun: [
    "$ page-probe --pages / /collections/green /collections/oolong /products/first-flush /pages/gift --viewports desktop,mobile --capture errors",
    "Every page and viewport: exactly one uncaught error.",
    "  message seen by the page's error handler: \"Script error.\" (no file, line or column)",
    "  message in the browser console: \"ReferLoop is already loaded. This message prevents duplicate loading of the script. Kindly ignore.\"",
    "  thrown by: https://cdn.storefront-assets.example/s/files/referloop-legacy.js",
    "Mobile add-to-cart on /products/first-flush with the error present: cart contains 1 item, total $46.",
  ].join("\n"),
  pageScripts: [
    "$ page-probe / --list-scripts --match referloop",
    "<script src=\"https://apps.referloop.example/embed.js\" data-source=\"app-embed\"></script>",
    "<script src=\"https://cdn.storefront-assets.example/s/files/referloop-legacy.js\" async></script>",
    "Neither tag has a crossorigin attribute; cdn.storefront-assets.example sends no Access-Control-Allow-Origin header.",
  ].join("\n"),
  blockProbe: [
    "$ page-probe / --block https://cdn.storefront-assets.example/s/files/referloop-legacy.js --capture errors",
    "uncaught errors: 0; window.ReferLoop defined: yes",
    "$ page-probe / --block https://apps.referloop.example/embed.js --capture errors",
    "uncaught errors: 0; window.ReferLoop defined: yes",
  ].join("\n"),
  appHistory: [
    "$ storefront apps history --app referloop",
    "2025-06-03  ReferLoop installed; legacy script tag referloop-legacy.js added by the app",
    "2026-02-26  ReferLoop app embed switched on in the theme; legacy script tag left in place",
  ].join("\n"),
};

function reviewCase(id: string, scenario: string, evidence: Record<string, string>, inspection: string): EvalCase {
  return {
    id,
    description: `Fresh-context reviewer for ${scenario}: rereads the cited evidence and writes its verdict to a file without changing anything else or starting another reviewer.`,
    prompt: reviewerPrompt,
    fixture: { evidence },
    expected: {
      requiredInspections: [inspection],
      requiredVerdictFile: true,
      forbiddenActions: [...mutations, "delegate"],
    },
  };
}

export const deepDiveCases: EvalCase[] = [
  {
    id: "deep-dive-wrong-lock-holder",
    description:
      "A process for the waiting PR looks like the lock holder; the lock file's epoch and a non-blocking flock probe show the earlier PR holds it, blocked on a CI job with no online runner.",
    prompt:
      "PR 421 has been waiting to land for almost half an hour. Which process is holding the land lock, and why? Don't kill or restart anything yet.",
    worker: { model: reviewer, caseId: "deep-dive-wrong-lock-holder-review" },
    agentsMd,
    rubric: [
      "Right cause: PR 418's land.sh (PID 51200) holds the lock while it waits on CI run 7781, which needs a self-hosted arm64 runner, and both arm64 runners are offline.",
      "Decoy ruled out: PR 421 holding the lock is named as ruled out with the evidence that broke it, such as 421 waiting in flock 9, the lock file recording 418 at 09:58:03 before 421 started, or PID 51702 being a separate interactive shell.",
      "Decisive evidence: lockFile and lockProbe are read and cited, and the lock file's epoch and the non-blocking flock probe are used as probes of who holds the lock.",
      provableReview,
    ],
    fixture: { evidence: lockEvidence },
    expected: {
      requiredSkills: ["deep-dive"],
      requiredInspections: ["processList", "lockFile", "lockProbe"],
      requiredWorker: true,
      citedReviewVerdict: true,
      forbiddenActions: mutations,
    },
  },
  reviewCase("deep-dive-wrong-lock-holder-review", "the lock-holder diagnosis", lockEvidence, "lockFile"),
  {
    id: "deep-dive-unloaded-instruction-blamed",
    description:
      "A weakly worded reply-length skill looks responsible; the session record shows it never loaded, while always-loaded AGENTS.md demands long replies.",
    prompt:
      "Agent replies in notes-app have been far too long all week, and yesterday's session s-0930 is typical. Why are they so long, and what should we change?",
    worker: { model: reviewer, caseId: "deep-dive-unloaded-instruction-blamed-review" },
    agentsMd,
    rubric: [
      "Right cause: the always-loaded AGENTS.md reply rule (Summary, files table, Next steps and full reasoning in every reply), added on 2026-09-28, makes the replies long.",
      "Decoy ruled out: rewording terse-replies is named as ruled out because session s-0930 never loaded it, and docs/agent-setup.md's claim that it applies to every session is not relied on.",
      "Decisive evidence: sessionTranscript and agentsMd are read and cited, and the transcript's load events are checked rather than assumed.",
      provableReview,
    ],
    fixture: { evidence: replyEvidence },
    expected: {
      requiredSkills: ["deep-dive"],
      requiredInspections: ["sessionTranscript", "agentsMd"],
      requiredWorker: true,
      citedReviewVerdict: true,
      forbiddenActions: mutations,
    },
  },
  reviewCase("deep-dive-unloaded-instruction-blamed-review", "the reply-length diagnosis", replyEvidence, "sessionTranscript"),
  {
    id: "deep-dive-private-data-leak",
    description:
      "A missed anonymization step looks responsible for private data in a public repository; the session record shows it never ran, the brief never established either repository's visibility, and no check ran at publication.",
    prompt:
      "We just found that tests/fixtures/invoices/*.json in our public repo example-oss/ledger-kit contain account IDs, customer names and internal hostnames from our private billing service. How did that get published? We want to stop it happening again.",
    worker: { model: reviewer, caseId: "deep-dive-private-data-leak-review" },
    agentsMd,
    rubric: [
      "Right cause: the brief never established either repository's visibility, and no visibility, data-origin or content check ran at publication.",
      "Decoy ruled out: a failed or buggy anonymization is named as ruled out with the evidence that broke it, such as anonymize.py never running in the command log or the fixtures hashing identically to the exports, and the PR description's anonymization claim is treated as false.",
      "Decisive evidence: taskBrief, sessionTranscript and repoVisibility are read and cited, and the command log or hashes are checked rather than the PR description.",
      provableReview,
    ],
    fixture: { evidence: leakEvidence },
    expected: {
      requiredSkills: ["deep-dive"],
      requiredInspections: ["taskBrief", "sessionTranscript"],
      requiredWorker: true,
      citedReviewVerdict: true,
      forbiddenActions: mutations,
    },
  },
  reviewCase("deep-dive-private-data-leak-review", "the data-leak diagnosis", leakEvidence, "sessionTranscript"),
  {
    id: "deep-dive-script-error-masked-duplicate",
    description:
      "A site-wide \"Script error.\" is blamed on a coincident checkout release; its onset date, page coverage and buyer rate rule that out, and a headless run shows a referral script loaded twice behind a cross-origin mask.",
    prompt:
      "PageLens shows \"Script error.\" on most sessions for Kettle & Kiln, and last week's funnel note says fixing it should be our first funnel fix. What is the error, and is it hurting sales?",
    worker: { model: reviewer, caseId: "deep-dive-script-error-masked-duplicate-review" },
    agentsMd,
    rubric: [
      "Right cause: ReferLoop loads twice (its app embed plus the legacy script tag left in place since 2026-02-26), the second copy's deliberate already-loaded error reaches PageLens as the cross-origin \"Script error.\", and the error is not shown to hurt sales.",
      "Decoy ruled out: the PayNest checkout widget is named as ruled out with the evidence that broke it, such as the errors starting on 2026-02-26 before its 2026-03-10 release, the error appearing on pages where PayNest does not load, or buyers having it at the same rate.",
      "Decisive evidence: headlessRun and blockProbe are read and cited, and the block probe is used to show that removing either copy removes the error.",
      provableReview,
    ],
    fixture: { evidence: scriptErrorEvidence },
    expected: {
      requiredSkills: ["deep-dive"],
      requiredInspections: ["errorSummary", "headlessRun"],
      requiredWorker: true,
      citedReviewVerdict: true,
      forbiddenActions: mutations,
    },
  },
  reviewCase("deep-dive-script-error-masked-duplicate-review", "the script-error diagnosis", scriptErrorEvidence, "headlessRun"),
];

import type { OwnedProcessGroup } from "./process-group.ts";
import { fixtureCommand } from "./github-fixture-target.ts";
import { join } from "node:path";
import { realpath } from "node:fs/promises";
import { z } from "zod";
import { digest } from "./github-live.ts";
import { atomicJson } from "./issue-receipt.ts";
import { publishReview, type ReviewForge, type ReviewRequest } from "./review-publication.ts";
import { stackPublisher } from "./stack-publication.ts";
import { nativeStackPublicationDriver } from "./stack-publication-driver.ts";
import { readOperationIntent } from "./operation-intent.ts";
import { runLocal, preflight } from "./local-runtime.ts";
import { loadSkills, formatSkillCatalog } from "./skill-loader.ts";
import { createEvalTools } from "./tools.ts";
import { baseFiles, storeFiles, batchFiles, runPipeline, pipelineProbes } from "./stack-program.ts";
import type { RunLedger } from "./types.ts";

import { inspectionPager } from "./inspection-pages.ts";
import { publishStackSubmission } from "./stack-partial-recovery.ts";

export const repairReviewSchema = {
  type: "object", additionalProperties: false,
  properties: { verdict: { type: "string", enum: ["clean", "findings"] }, findings: { type: "array", items: {
    type: "object", additionalProperties: false,
    properties: { path: { type: "string" }, line: { type: "integer" }, summary: { type: "string" }, witnessIds: { type: "array", items: { type: "string" } } },
    required: ["path", "line", "summary", "witnessIds"],
  } } }, required: ["verdict", "findings"],
};
export const repairModels: Record<string, string> = {
  "codex:gpt-6-astra": "GPT-6 Astra", "claude:claude-fable-5-1": "Fable 5.1", "claude:claude-opus-5": "Opus 5",
};
export function requireRepairReviewSkills(loadedSkills: string[]) {
  const missing = ["code-review", "test-against-spec"].filter(skill => !loadedSkills.includes(skill));
  if (missing.length) throw Error(`Independent review must load required skills before inspecting: ${missing.join(", ")}`);
}
export function validateRepairFindings(verdict: any, readablePaths: string[], probes: { id: string; passed: boolean }[]) {
  if (!Array.isArray(verdict.findings) || !["clean", "findings"].includes(verdict.verdict) ||
      (verdict.verdict === "clean") !== (verdict.findings.length === 0)) throw Error("Inconsistent review verdict");
  for (const f of verdict.findings) {
    if (!readablePaths.includes(f.path) || !Number.isInteger(f.line) || f.line <= 0)
      throw Error(`Independent finding is outside readable fixture scope: ${f.path}:${f.line}`);
    if (!Array.isArray(f.witnessIds) || !f.witnessIds.length || f.witnessIds.some((id: string) => !probes.some(p => p.id === id && !p.passed)))
      throw Error(`Independent finding lacks an executed failing witness: ${f.path}:${f.line}`);
  }
}
export async function stackRepairTools(configPath: string, ledger: RunLedger, executionOwner: OwnedProcessGroup) {
  const c = await Bun.file(configPath).json();
  if (c.repository !== "frostney/kgr-eval-20260906-native-stack" || c.repositoryId !== 1358673926 ||
      !Number.isSafeInteger(c.stackNumber) || c.stackNumber <= 0 || c.stackNumber !== c.stack.number ||
      c.stack.pull_requests.length !== 2 || c.localHeads.length !== 2 || c.branches.length !== 2 || !repairModels[c.model])
    throw Error("Unexpected repair fixture identity");
  const run = fixtureCommand(c.repository);
  const git = (...args: string[]) => run(["git", ...args], c.directory);
  const gh = (...args: string[]) => run(["gh", ...args], c.directory);
  const api = async (path: string, body?: any) => JSON.parse(await run([
    "gh", "api", `repos/${c.repository}${path}`, ...(body ? ["--method", "POST", "--input", "-"] : []),
  ], undefined, body ? JSON.stringify(body) : undefined));
  const pages = async (path: string) => {
    const value = JSON.parse(await gh("api", `repos/${c.repository}${path}?per_page=100`, "--paginate", "--slurp"));
    if (!Array.isArray(value) || value.some(p => !Array.isArray(p))) throw Error("Malformed GitHub pagination");
    return value.flat();
  };
  const reviewForge = (pr: number): ReviewForge => ({
    identity: () => api(""), actor: () => gh("api", "user", "--jq", ".login"),
    head: async () => (await api(`/pulls/${pr}`)).head.sha,
    list: () => pages(`/pulls/${pr}/reviews`), get: id => api(`/pulls/${pr}/reviews/${id}`),
    comments: id => pages(`/pulls/${pr}/reviews/${id}/comments`), comment: id => api(`/pulls/comments/${id}`),
    create: body => api(`/pulls/${pr}/reviews`, body),
  });
  const remote = await api("");
  if (remote.id !== c.repositoryId || !remote.private || (await gh("api", "user", "--jq", ".login")) !== "frostney")
    throw Error("Unexpected live repository or authenticated account");
  const statePath = join(c.evidence, "state.json");
  const readState = () => Bun.file(statePath).json();
  const publicationContext = { repository: c.repository, repositoryId: c.repositoryId, directory: await realpath(c.directory),
    stack: c.stackNumber, stackId: c.stack.id, baseRef: c.defaultBranch, base: c.base, branch: c.fixBranch,
    prefix: c.stack.pull_requests.map((p: any, i: number) => ({ pr: p.number, branch: c.branches[i], head: c.localHeads[i] })) };
  const publicationEvidence = join(c.evidence, "stack-publication");
  const publicationDriver = nativeStackPublicationDriver(publicationContext, c.pythonBinary);
  const publisher = stackPublisher(publicationContext, publicationDriver, publicationEvidence, { executionOwner });
  const files = Object.keys({ ...baseFiles, ...storeFiles, ...batchFiles });
  const editable = Object.keys({ ...storeFiles, ...batchFiles }).filter(p => p.startsWith("src/"));
  const revision = async () => digest(JSON.stringify(await Promise.all(files.map(async p => [p, await Bun.file(join(c.directory, p)).text()]))));
  const save = async (state: any, event: string, detail: any = {}) => {
    state.events.push({ event, detail, at: new Date().toISOString() });
    await atomicJson(statePath, state);
    if (!c.reviewScope && c.interruptAfter === event) {
      await atomicJson(join(c.attemptDirectory, "stop-requested.json"), { event, at: new Date().toISOString(), pid: process.pid });
      // The native coordinator is deliberately stopped at this durable boundary.
      // Do not start the next GitHub operation before the host has interrupted it.
      await new Promise(() => {});
    }
  };
  const liveStack = async () => {
    let state = await readState();
    if (!c.reviewScope && ((!state.fixBranchCreated && await Bun.file(join(publicationEvidence, "branch-intent.json")).exists()) ||
        (!state.fixHead && await Bun.file(join(publicationEvidence, "commit-intent.json")).exists()) ||
        (!state.fixPr && await Bun.file(join(publicationEvidence, "submit-intent.json")).exists()))) {
      const recovered = await publisher.reconcile();
      let changed = false;
      if (recovered.branch?.state === "verified" && !state.fixBranchCreated) { state.fixBranchCreated = true; changed = true; }
      if (recovered.commit?.state === "verified" && !state.fixHead) { state.fixHead = recovered.commit.head; changed = true; }
      if (recovered.submit?.state === "verified" && !state.fixPr) { state.fixPr = recovered.submit.pr; changed = true; }
      if (changed) { await save(state, "publicationRecovered", recovered); state = await readState(); }
    }
    const live = JSON.parse(await run(["python3", join(c.skillsRoot, "address-feedback/scripts/stack_state.py"),
      "inspect", "--repo", c.repository, "--stack", String(c.stackNumber), "--json"]));
    const members = live.observation.members;
    if (live.observation.id !== c.stack.id || live.observation.base.sha !== c.base ||
        members.length !== (state.fixPr ? 3 : 2) ||
        members.slice(0, 2).some((m: any, i: number) => m.pr !== c.stack.pull_requests[i].number || m.head !== c.localHeads[i]) ||
        (state.fixPr && (members[2].pr !== state.fixPr || members[2].head !== state.fixHead)))
      throw Error("Live stack drifted outside the admitted repair state");
    return live;
  };
  const gate = async () => {
    await liveStack();
    const before = await revision();
    const visible = await runPipeline(c.directory, {}, c.nodeBinary, true);
    const probes = [];
    for (const input of pipelineProbes) {
      const observed = await runPipeline(c.directory, input, c.nodeBinary);
      probes.push({ id: digest(JSON.stringify({ revision: before, input, ...observed })), input, ...observed });
    }
    if (before !== await revision()) throw Error("Source changed during validation");
    const value = { revision: before, visible, probes, passed: visible.passed && probes.every(p => p.passed) };
    const state = await readState(); state.gate = value;
    await save(state, "gate", { revision: before, passed: value.passed });
    await atomicJson(join(c.evidence, `gate-${before}.json`), value);
    await atomicJson(join(c.evidence, `gate-digest-${digest(JSON.stringify(value))}.json`), value);
    return value;
  };
  const base = createEvalTools(await loadSkills(c.skillsRoot), { id: "native-stack-repair", prompt: "", description: "", fixture: { evidence: {} }, expected: {} }, ledger);
  const tool = (description: string, inputSchema: any, execute: any) => ({ description, inputSchema, execute });
  const inspect = async () => {
    if (c.reviewScope) requireRepairReviewSkills(ledger.loadedSkills);
    const live = await liveStack(), state = await readState();
    const source = Object.fromEntries(await Promise.all(files.map(async p => [p, await Bun.file(join(c.directory, p)).text()])));
    const prs = [];
    for (const member of live.observation.members) {
      const pull = await api(`/pulls/${member.pr}`);
      const diff = await api(`/pulls/${member.pr}/files?per_page=100`);
      prs.push({ pr: member.pr, head: member.head, title: pull.title, body: pull.body, diff });
    }
    return { live, source, prs, state: { ...state, events: state.events.map((e: any) => ({ event: e.event, at: e.at })) },
      workingChange: await git("diff", c.localHeads[1], "--"), revision: await revision(), reviewScope: c.reviewScope ?? null,
      attribution: { user: "frostney", model: repairModels[c.model], evidence: "authenticated gh user and native CLI model selection" } };
  };
  const inspection = inspectionPager();
  const tools: any = { loadSkill: base.loadSkill, readSkillReference: base.readSkillReference,
    inspectRepairStack: tool("Read a fresh snapshot of actual native topology, exact PR diffs/bodies, integrated source/contract/tests and recorded gates/reviews. Start with no arguments, then call with its snapshotId and nextOffset until nextOffset is null. Pages are bounded JSON text fragments; read every page before assessing or acting. No mutation.",
      z.object({ snapshotId: z.string().optional(), offset: z.number().int().nonnegative().optional() }), async ({ snapshotId, offset }: any) => {
        if (!snapshotId && offset !== undefined) throw Error("Continuation requires the returned snapshotId");
        if (!snapshotId) ledger.inspections = ledger.inspections.filter(value => value !== "repair-stack");
        const page = snapshotId ? inspection.read(snapshotId, offset ?? 0) : inspection.capture(await inspect());
        if (page.complete && !ledger.inspections.includes("repair-stack")) ledger.inspections.push("repair-stack");
        return page;
      }) };
  if (c.reviewScope) return tools;
  const requireProcedure = () => {
    if (!ledger.loadedSkills.includes("address-feedback")) throw Error("Load address-feedback before workflow actions");
    if (!ledger.inspections.includes("repair-stack")) throw Error("Read every inspection page before workflow actions");
  };
  const requireGate = async () => {
    const state = await readState();
    if (!state.gate?.passed || state.gate.revision !== await revision()) throw Error("Current integrated gate is not passing");
    return state;
  };
  const independent = async (scope: any) => {
    requireProcedure(); await liveStack();
    const state = await readState(), rev = await revision();
    if (state.gate?.revision !== rev) throw Error("Run current interface gate before review");
    const attempt = crypto.randomUUID();
    const cfg = join(c.evidence, `review-${attempt}-config.json`);
    await atomicJson(cfg, { ...c, reviewScope: scope });
    const target = c.model === "claude:claude-fable-5-1" ? "claude:claude-opus-5" : c.model;
    const version = await preflight(target);
    const result = await runLocal({ target, effort: "medium", skillsRoot: c.skillsRoot,
      evalCase: { id: "stack-independent-review", description: "", fixture: { evidence: {} }, expected: {},
        prompt: `Use code-review for a fresh read-only correctness review and test-against-spec to assess the recorded real CLI evidence. Inspect the actual stack. Scope: ${JSON.stringify(scope)}. For an original member, assess its own PR claim/diff at the recorded head, using the integrated top to establish whether its findings remain live; do not attribute integrated execution to the lower head. For a fix, review the whole integrated repair and the publication metadata if present. Fixture tests, workflow and contract are fixed inputs; assess behavior using both visible tests and independent CLI probes. A coverage finding may refer to a read-only test file; its disposition must respect the fixed-file constraint. Reuse only matching current gate evidence. Return clean or concrete findings with the originating diff path/line and actually failing witness IDs. No mutation or further delegation.` },
      instructions: formatSkillCatalog(await loadSkills(c.skillsRoot)) + "\nUse only the read-only fixture tools. Every finding must be within the requested claim and supported by an actual failing witness. Do not report style-only changes. No independent external provider is implied.",
      transcript: join(c.evidence, `review-${attempt}.jsonl`), responseSchema: repairReviewSchema,
      server: { path: join(c.skillsRoot, "evals/stack-repair-server.ts"), args: [cfg], approvedTools: ["loadSkill", "readSkillReference", "inspectRepairStack"] },
    });
    await atomicJson(join(c.evidence, `review-${attempt}-native.json`), result);
    if (result.error || result.exitCode !== 0 || result.cancellationRequested)
      throw Error(`Independent reviewer process failed or was interrupted; preserve raw attempt ${attempt}`);
    requireRepairReviewSkills(result.ledger.loadedSkills);
    if (!result.ledger.inspections.includes("repair-stack")) throw Error("Independent review did not read every inspection page");
    if (rev !== await revision()) throw Error("Integrated content changed during independent review");
    const verdict = JSON.parse(result.output);
    validateRepairFindings(verdict, files, state.gate.probes);
    const receipt = { attempt, revision: rev, gateDigest: digest(JSON.stringify(state.gate)), target, version, scope, verdict, completed: true, at: new Date().toISOString() };
    state.reviews.push(receipt); await save(state, "review", receipt);
    return receipt;
  };
  tools.runRepairGate = tool("Execute the visible project tests and all independent CLI contract probes at the actual integrated working content.", z.object({}), async () => { requireProcedure(); return gate(); });
  tools.reviewOriginalMember = tool("Run an independent native correctness/spec review of one original PR at its exact head. Publish verified findings as a COMMENT review with inline source threads, preserving the original head.", z.object({ pr: z.number().int() }), async ({ pr }: any) => {
    const index = c.stack.pull_requests.findIndex((p: any) => p.number === pr);
    if (index < 0) throw Error("Not an original member");
    requireProcedure(); await liveStack();
    let state = await readState();
    const rev = await revision();
    const prior = state.originalReviews[pr];
    if (prior && !prior.publication) throw Error("Legacy review needs explicit read-only verification; do not republish it");
    // Reuse the successful reviewer attempt when a POST may already have
    // happened. A fresh attempt would change the request and evade its journal.
    const receipt = prior ?? state.reviews.findLast((r: any) => r.completed && r.scope.kind === "original" &&
      r.scope.pr === pr && r.scope.head === c.localHeads[index] && r.revision === rev) ??
      await independent({ kind: "original", pr, head: c.localHeads[index], claim: index === 0 ? "record store only" : "validation, batches and CLI" });
    if (receipt.revision !== rev) throw Error("Original review no longer matches the integrated source");
    if (!receipt.verdict.findings.length) throw Error("Seeded original review failed to find its live defect");
    const allowed = (await api(`/pulls/${pr}/files?per_page=100`)).map((f: any) => f.filename);
    if (receipt.verdict.findings.some((f: any) => !allowed.includes(f.path))) throw Error("Finding does not originate in member diff");
    const modelName = repairModels[receipt.target];
    const note = `\n\n> [!NOTE]\n> Created on behalf of @frostney using ${modelName}.`;
    const request: ReviewRequest = { repository: c.repository, repositoryId: c.repositoryId, pr,
      head: c.localHeads[index], actor: "frostney", operation: `stack-${c.stackNumber}-pr-${pr}-original`,
      attempt: receipt.attempt, revision: receipt.revision, model: receipt.target,
      body: `Native independent fixture review identified ${receipt.verdict.findings.length} contract finding(s). Findings remain live at the integrated top. Review attempt: ${receipt.attempt}.${note}`,
      comments: receipt.verdict.findings.map((f: any) => ({ path: f.path, line: f.line, side: "RIGHT", body: f.summary + `\n\nExecutable witnesses: ${f.witnessIds.join(", ")}.${note}` })) };
    const publication = await publishReview(request, reviewForge(pr), join(c.evidence, `original-review-${pr}-intent.json`));
    if (publication.state !== "verified") throw Error(`Original review publication ${publication.state}: ${publication.reason}`);
    await liveStack();
    if (rev !== await revision()) throw Error("Integrated source changed during review publication");
    state = await readState(); state.originalReviews[pr] = { ...receipt, github: publication.review, publication };
    await save(state, "originalReviewPublished", { pr, review: publication.review.id });
    return state.originalReviews[pr];
  });
  tools.createFixLayer = tool("Create one new top branch through official gh stack add after both original reviews. Frozen original heads are preserved.", z.object({}), async () => {
    requireProcedure(); await liveStack(); const state = await readState();
    if (state.fixBranchCreated) return { branch: c.fixBranch };
    if (Object.keys(state.originalReviews).length !== 2 || await git("status", "--porcelain") ||
        !c.stack.pull_requests.every((p: any) => state.ci.some((v: any) => v.state === "satisfied" && v.identity.pr === p.number && v.identity.head === p.head.sha)))
      throw Error("Need both original reviews, exact-head CI and a clean worktree");
    const publication = await publisher.createBranch();
    if (publication.state !== "verified") throw Error("Branch creation is pending reconciliation; preserve its intent");
    state.fixBranchCreated = true;
    await save(state, "fixBranchCreated", { branch: c.fixBranch }); return { branch: c.fixBranch };
  });
  tools.replaceRepairSource = tool("Replace exactly one source occurrence on the new fix branch. Tests/workflows/contracts and frozen original branches cannot be edited.", z.object({ path: z.string(), oldText: z.string().min(1), newText: z.string() }), async ({ path, oldText, newText }: any) => {
    requireProcedure(); await liveStack(); const state = await readState();
    if (!state.fixBranchCreated || state.fixHead || state.fixPr || !editable.includes(path) || await git("branch", "--show-current") !== c.fixBranch)
      throw Error("Source editing is restricted to the uncommitted fix branch");
    const file = join(c.directory, path), before = await Bun.file(file).text();
    if (before.split(oldText).length !== 2) throw Error("Replacement must match exactly once");
    await Bun.write(file, before.replace(oldText, newText));
    await save(state, "sourceChanged", { path, revision: await revision() }); return { path, revision: await revision() };
  });
  tools.reviewFix = tool("Run an independent native code/spec review of the passing integrated repair. Run before publication and again after publication for exact-head PR context.", z.object({}), async () => {
    const state = await requireGate();
    return independent({ kind: state.fixPr ? "published-fix" : "local-fix", pr: state.fixPr ?? null, head: state.fixHead ?? null });
  });
  tools.publishFixLayer = tool("Commit validated source edits and publish the new draft fix layer while preserving approved lower heads and dependencies. Requires a matching clean independent local review and passing gate. No merge.", z.object({}), async () => {
    requireProcedure(); await liveStack(); let state = await requireGate();
    if (state.final?.state === "ready") return { pr: state.fixPr, head: state.fixHead };
    if (!state.reviews.some((r: any) => r.completed && r.scope.kind === "local-fix" && r.revision === state.gate.revision && r.verdict.verdict === "clean")) throw Error("Missing clean independent local review");
    if (!state.fixPr) {
      const review = state.reviews.findLast((r: any) => r.completed && r.scope.kind === "local-fix" &&
        r.revision === state.gate.revision && r.verdict.verdict === "clean");
      const prior: any = await readOperationIntent(join(publicationEvidence, "commit-intent.json"));
      const admission = prior?.admission ?? { revision: state.gate.revision, reviewAttempt: review.attempt,
        gateDigest: digest(JSON.stringify(state.gate)) };
      if (prior) {
        const admittedGate = await Bun.file(join(c.evidence, `gate-digest-${admission.gateDigest}.json`)).json();
        if (!admittedGate.passed || admittedGate.revision !== state.gate.revision || digest(JSON.stringify(admittedGate)) !== admission.gateDigest ||
            !state.reviews.some((r: any) => r.attempt === admission.reviewAttempt && r.completed && r.scope.kind === "local-fix" &&
              r.revision === state.gate.revision && r.gateDigest === admission.gateDigest && r.verdict.verdict === "clean"))
          throw Error("Recovered commit lacks its original completed review and gate evidence");
      }
      const committed = await publisher.commit(admission, editable, "fix: preserve JSON values and atomic batch state");
      if (committed.state !== "verified") throw Error("Commit outcome is pending reconciliation; preserve its intent");
      state.fixHead = committed.head; await save(state, "fixCommitted", { head: state.fixHead });
      const published = await publishStackSubmission(publicationContext, publicationDriver, publicationEvidence, executionOwner, state.fixHead);
      if (published.state !== "verified") throw Error("Stack submission is incomplete or uncertain; preserve its intent and reconcile actual remote state");
      state.fixPr = published.pr; await save(state, "fixPublished", { pr: state.fixPr, head: state.fixHead });
    }
    await liveStack();
    const body = `## Claim\n\nPreserve every JSON value on lookup and reject invalid batches before applying any writes. This new top layer covers the native findings on ${c.stack.pull_requests.map((p: any) => `PR #${p.number}`).join(" and ")} while preserving their exact heads.\n\n## Validation\n\nThe visible project gate and all20independent CLI contract probes passed for the submitted content. An independent native code/spec review returned clean before publication; exact-head CI and a post-publication review remain required. No merge is authorized.\n`;
    const bodyPath = join(c.evidence, "fix-pr-body.md"); await Bun.write(bodyPath, body);
    await gh("pr", "edit", String(state.fixPr), "--title", "fix: preserve JSON values and atomic batch state", "--body-file", bodyPath);
    return { pr: state.fixPr, head: state.fixHead, url: `https://github.com/${c.repository}/pull/${state.fixPr}` };
  });
  tools.awaitStackChecks = tool("Passively await required project-gate CI for every exact current stack head using the deterministic delivery helper.", z.object({}), async () => {
    requireProcedure(); const live = await liveStack(); const results = [];
    for (const member of live.observation.members) results.push(JSON.parse(await run([
      "python3", join(c.skillsRoot, "delivery-wait/scripts/delivery_wait.py"), "wait", "checks-terminal",
      "--repo", c.repository, "--pr", String(member.pr), "--head", member.head, "--check", "project-gate",
      "--deadline", new Date(Date.now() + 300_000).toISOString(), "--interval", "5", "--state", join(c.evidence, `ci-${member.pr}-${member.head}.json`), "--json",
    ])));
    const state = await readState(); state.ci = results; await save(state, "ciObserved");
    return results;
  });
  const requireDelivery = async () => {
    const live = await liveStack(), state = await requireGate();
    if (!state.fixPr || !state.reviews.some((r: any) => r.completed && r.scope.kind === "published-fix" && r.scope.head === state.fixHead && r.revision === state.gate.revision && r.verdict.verdict === "clean") ||
        !live.observation.members.every((m: any) => state.ci.some((v: any) => v.state === "satisfied" && v.identity.pr === m.pr && v.identity.head === m.head)))
      throw Error("Need published exact-head clean review and all current CI before feedback closure");
    return state;
  };
  tools.inspectRepairFeedback = tool("Read current feedback/thread IDs through the real bundled helper. Missing policy remains unknown; native reviewer receipts are retained separately.", z.object({ pr: z.number().int() }), async ({ pr }: any) => {
    const live = await liveStack(), member = live.observation.members.find((m: any) => m.pr === pr);
    if (!member) throw Error("Not a current stack member");
    return JSON.parse(await run(["python3", join(c.skillsRoot, "address-feedback/scripts/review_wait.py"), "inspect",
      "--repo", c.repository, "--pr", String(pr), "--head", member.head, "--policy", join(c.evidence, "no-automation-policy.json"), "--json"]));
  });
  tools.replyToRepairFinding = tool("Publish an explicitly supplied attributed reply on an original finding, after current repair review/CI. Receipt binds target, body, actor, operation and head; retries reconcile without duplicate writes.", z.object({ pr: z.number().int(), commentId: z.number().int(), body: z.string(), operationId: z.string() }), async ({ pr, commentId, body, operationId }: any) => {
    requireProcedure(); const state = await requireDelivery();
    const member = c.stack.pull_requests.find((p: any) => p.number === pr);
    if (!member || !body.includes(state.fixHead) || !body.includes(`/pull/${state.fixPr}`) || !body.includes(`Created on behalf of @frostney using ${repairModels[c.model]}.`)) throw Error("Reply needs exact fix commit, PR link and observed attribution");
    const value = JSON.parse(await run(["python3", join(c.skillsRoot, "address-feedback/scripts/review_wait.py"), "reply",
      "--repo", c.repository, "--pr", String(pr), "--head", member.head.sha, "--comment-id", String(commentId), "--body", body,
      "--operation-id", operationId, "--state", join(c.evidence, `reply-${pr}-${commentId}.json`), "--json"]));
    state.replies.push({ pr, commentId, result: value }); await save(state, "replyObserved", { pr, commentId, state: value.state }); return value;
  });
  tools.resolveRepairFinding = tool("Resolve an explicitly selected original finding thread only after its matching reply receipt and current repair evidence exist; reverify scoped thread state afterward.", z.object({ pr: z.number().int(), threadId: z.string(), commentId: z.number().int() }), async ({ pr, threadId, commentId }: any) => {
    requireProcedure(); const state = await requireDelivery();
    const member = c.stack.pull_requests.find((p: any) => p.number === pr);
    if (!member || !state.replies.some((r: any) => r.pr === pr && r.commentId === commentId && r.result.state === "satisfied")) throw Error("No matching successful reply receipt");
    const feedback = await tools.inspectRepairFeedback.execute({ pr });
    if (!feedback.observation.threads.some((t: any) => t.id === threadId && t.comments.some((x: any) => x.id === commentId))) throw Error("Reply target does not belong to this thread");
    const value = JSON.parse(await run(["python3", join(c.skillsRoot, "address-feedback/scripts/review_wait.py"), "resolve",
      "--repo", c.repository, "--pr", String(pr), "--head", member.head.sha, "--thread-id", threadId, "--json"]));
    state.resolutions.push({ pr, threadId, result: value }); await save(state, "resolutionObserved", { pr, threadId, state: value.state }); return value;
  });
  tools.finalizeRepairStack = tool("Verify complete native membership, current gate/reviews/CI and resolved/replied findings; mark the three draft fixture PRs ready for review and record whole-stack readiness. Never merge.", z.object({}), async () => {
    requireProcedure(); await requireDelivery(); await tools.awaitStackChecks.execute({});
    const state = await requireDelivery(), live = await liveStack();
    const feedback = [];
    for (const member of live.observation.members) {
      const value = await tools.inspectRepairFeedback.execute({ pr: member.pr }); feedback.push(value);
      if (value.observation.unresolvedThreads !== 0) throw Error("Unresolved stack findings remain");
      for (const surface of value.observation.findingSurfaces) {
        if (surface.kind !== "review" || surface.id !== state.originalReviews[member.pr]?.github.node_id)
          throw Error("Unexpected feedback surface needs classification before readiness");
      }
    }
    if (!state.resolutions.length || state.resolutions.some((r: any) => r.result.state !== "satisfied")) throw Error("No verified source finding coverage");
    for (const member of live.observation.members) {
      const pull = await api(`/pulls/${member.pr}`);
      const coverage = `\n\n## Verified stack coverage\n\nThe complete stack uses fix layer #${state.fixPr} at ${state.fixHead}. Its integrated project gate and all20CLI contract probes passed; independent native pre-publication and post-publication reviews completed clean. Required project-gate CI passed for every current head. The original finding threads have verified fix replies and are resolved. Original layers retain their own source defects and require the complete stack including the fix layer. No merge was performed or authorized.\n`;
      const bodyPath = join(c.evidence, `final-pr-${member.pr}-body.md`);
      await Bun.write(bodyPath, String(pull.body).split("\n\n## Verified stack coverage")[0] + coverage);
      await gh("pr", "edit", String(member.pr), "--body-file", bodyPath);
    }
    for (const member of live.observation.members) if (member.draft) await gh("pr", "ready", String(member.pr));
    state.final = { state: "ready", live: await liveStack(), feedback, gate: state.gate.revision, fixPr: state.fixPr, fixHead: state.fixHead };
    await save(state, "stackReady"); return state.final;
  });
  return tools;
}

import { join } from "node:path";
import { issueDigest } from "./issue-receipt.ts";
import { claimOperation, readOperationIntent } from "./operation-intent.ts";
import { requireGroupStopped, type OwnedProcessGroup } from "./process-group.ts";
import { publicationExecutionRequest, recordPublicationExecution, type SubmissionPhase } from "./publication-execution.ts";
import { stackPublisher, type PublicationOutcome, type StackPublicationContext, type StackPublicationDriver } from "./stack-publication.ts";

type RecoveryHooks = { afterClaim?: () => Promise<void>; afterLink?: () => Promise<void>; afterCreate?: () => Promise<void> };

export async function publishStackSubmission(context: StackPublicationContext, driver: StackPublicationDriver, evidence: string,
  owner: OwnedProcessGroup, head: string, hooks: RecoveryHooks = {}): Promise<PublicationOutcome> {
  let pushedHere = false;
  const publishing = { ...driver, submit: async (head: string) => { await driver.submit(head); pushedHere = true; } };
  const outcome = await stackPublisher(context, publishing, evidence, { executionOwner: owner }).submit(head);
  if (outcome.state === "verified") return outcome;
  const completedHere = new Set<SubmissionPhase>();
  if (pushedHere) {
    if (outcome.snapshot.remote.heads[context.branch] !== head || outcome.snapshot.remote.candidates.length ||
        outcome.snapshot.remote.members.length !== context.prefix.length)
      return { ...outcome, reason: "Push effects differ from branch-only publication; preserve the intent and reconcile" };
    if (!await claimOperation(join(evidence, "submit-completion.json"), { context, head,
      executorDigest: issueDigest(await readOperationIntent(join(evidence, "submit-executor.json"))) }))
      throw Error("Submission already has a completion record");
    completedHere.add("submit");
  }
  return continueSubmission(context, driver, evidence, owner, hooks, completedHere);
}

export async function recoverStackSubmission(context: StackPublicationContext, driver: StackPublicationDriver, evidence: string,
  owner: OwnedProcessGroup, hooks: RecoveryHooks = {}): Promise<PublicationOutcome> {
  return continueSubmission(context, driver, evidence, owner, hooks, new Set());
}

async function continueSubmission(context: StackPublicationContext, driver: StackPublicationDriver, evidence: string,
  owner: OwnedProcessGroup, hooks: RecoveryHooks, completedHere: Set<SubmissionPhase>): Promise<PublicationOutcome> {
  async function remaining(): Promise<PublicationOutcome> {
  const publisher = stackPublisher(context, driver, evidence);
  const observed = (await publisher.reconcile()).submit;
  if (!observed) throw Error("Partial recovery requires an existing submission intent");
  if (observed.state === "verified") return observed;
  const request = await readOperationIntent(join(evidence, "submit-intent.json"));
  const priorExecutions = [];
  for (const phase of ["submit", "link-branch", "create-pr", "link-pr"] as SubmissionPhase[]) {
    const intent = phase === "submit" ? request : await readOperationIntent(join(evidence, `${phase}-intent.json`));
    if (intent === undefined) continue;
    if (phase !== "submit") {
      const saved: any = intent;
      if (saved.kind !== "finish-submission" || saved.phase !== phase || saved.head !== observed.head ||
          issueDigest(saved.context) !== issueDigest(context) || saved.originalRequestDigest !== issueDigest(request) ||
          issueDigest(saved.predecessorExecutions) !== issueDigest(priorExecutions.map(issueDigest)))
        throw Error("Prior recovery phase belongs to another submission");
    }
    const execution: any = await readOperationIntent(join(evidence, `${phase}-executor.json`));
    if (!execution) return { ...observed, reason: "Prior submission execution ownership is incomplete; preserve its evidence" };
    if (issueDigest(execution) !== issueDigest(publicationExecutionRequest(phase, intent, execution.owner)))
      throw Error("Prior publication executor is bound to another request");
    if (execution.owner.group === owner.group) {
      if (!completedHere.has(phase)) return { ...observed, reason: "The original publication group still owns this attempt" };
    } else await requireGroupStopped(execution.owner);
    priorExecutions.push(execution);
  }
  const s = observed.snapshot, candidate = s.remote.candidates[0], head = observed.head!;
  if (s.remote.heads[context.branch] !== head || s.remote.members.length !== context.prefix.length)
    return { ...observed, reason: "No fully observed pushed branch permits a remaining publication phase" };
  const phase: SubmissionPhase = candidate ? "link-pr" : "create-pr";
  if (phase === "create-pr" && await readOperationIntent(join(evidence, "link-branch-intent.json")) !== undefined)
    return { ...observed, reason: "Legacy branch linking is uncertain; reconcile visibility without creating another PR" };
  const continuation = { kind: "finish-submission", phase, context, head, pr: candidate?.pr ?? null,
    originalRequestDigest: issueDigest(request), predecessorExecutions: priorExecutions.map(issueDigest) };
  const intentPath = join(evidence, `${phase}-intent.json`);
  const prior = await readOperationIntent(intentPath);
  if (prior !== undefined) {
    // An uncertain attempt at this same phase does not authorize another write.
    // A subsequently visible PR can advance link-branch to the distinct link-pr phase.
    return { ...observed, reason: "This remaining phase already has an intent; reconcile visibility without repeating it" };
  }
  if (phase === "create-pr" ? !driver.createPR : !driver.link) throw Error("Native publication capability is unavailable");
  if (!await claimOperation(intentPath, continuation)) return { ...observed, reason: "Another coordinator owns the remaining phase" };
  await recordPublicationExecution(evidence, phase, continuation, owner);
  await hooks.afterClaim?.();
  const before = (await publisher.reconcile()).submit!;
  if (before.state === "verified") return before;
  const current = before.snapshot;
  if (current.remote.heads[context.branch] !== head || current.remote.members.length !== context.prefix.length ||
      (current.remote.candidates[0]?.pr ?? null) !== (candidate?.pr ?? null)) throw Error("Partial publication changed before native linking");
  if (phase === "create-pr") {
    try { await driver.createPR!(head); }
    catch { return { ...(await publisher.reconcile()).submit!, reason: "PR creation response is uncertain; reconcile after this executor stops" }; }
    const created = (await publisher.reconcile()).submit!;
    if (created.state === "verified") throw Error("PR creation unexpectedly changed native membership");
    const pr = created.snapshot.remote.candidates[0]?.pr;
    if (!pr) return { ...created, reason: "PR creation is not visible; preserve its intent" };
    if (!await claimOperation(join(evidence, "create-pr-completion.json"), { context, head, pr,
      executorDigest: issueDigest(await readOperationIntent(join(evidence, "create-pr-executor.json"))) }))
      throw Error("PR creation already has a completion record");
    completedHere.add("create-pr");
    await hooks.afterCreate?.();
    return remaining();
  }
  try { await driver.link!(candidate!.pr, head); await hooks.afterLink?.(); }
  catch { /* Keep the immutable phase intent and reconcile actual remote effects. */ }
  return (await publisher.reconcile()).submit!;
  }
  return remaining();
}

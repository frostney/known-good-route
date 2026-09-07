import { join } from "node:path";
import { issueDigest } from "./issue-receipt.ts";
import { claimOperation } from "./operation-intent.ts";
import { groupProcesses, ownedProcessGroup, type OwnedProcessGroup } from "./process-group.ts";

export type SubmissionPhase = "submit" | "link-branch" | "create-pr" | "link-pr";
export const publicationExecutionRequest = (phase: SubmissionPhase, request: unknown, owner: OwnedProcessGroup) =>
  ({ kind: "publication-execution", phase, requestDigest: issueDigest(request), owner });
export async function recordPublicationExecution(evidence: string, phase: SubmissionPhase, request: unknown, owner: OwnedProcessGroup) {
  if (issueDigest(await ownedProcessGroup(owner.group)) !== issueDigest(owner) ||
      !(await groupProcesses(owner.group)).some(p => p.pid === process.pid)) throw Error("Publication executor is outside its recorded group");
  if (!await claimOperation(join(evidence, `${phase}-executor.json`), publicationExecutionRequest(phase, request, owner)))
    throw Error("Publication execution already has an owner");
}

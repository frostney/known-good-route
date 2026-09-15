import { createHash } from "node:crypto";
import { acknowledgmentOnlyActions } from "./action-evidence.ts";
import { join } from "node:path";
import { z } from "zod";
import { parseEvents, parseModel, runLocal } from "./local-runtime.ts";
import type { EvalRunRecord } from "./types.ts";
import { semanticInstructions, type SemanticPacket } from "./semantic-review.ts";
import { claimExtractionInstructions, communicationSources, extractedClaimsSchema, outcomeReviewInstructions, outcomeReviewSchema, validateExtractedClaims, validateOutcomeReview } from "./outcome-claims.ts";

// Claude Code requires draft-7 rather than the converter's default draft.
export const semanticNativeSchema = z.toJSONSchema(outcomeReviewSchema, { target: "draft-7" });
const extractionNativeSchema = z.toJSONSchema(extractedClaimsSchema, { target: "draft-7" });

export function verifyCandidateTranscript(record: EvalRunRecord, transcript: string) {
  const target = parseModel(record.model);
  const native = parseEvents(target.cli, transcript);
  if (record.error || native.error || native.output !== record.output)
    throw new Error("Candidate final response does not match a completed native transcript");
  // Codex does not currently expose response-model identity in these streams.
  // Preserve configured-only identity rather than inventing observed evidence.
  if (target.cli === "claude" && (!native.responseModels.length ||
      native.responseModels.some(model => model !== target.model)))
    throw new Error("Candidate response-model identity is missing or mismatched");
}

export async function runSemanticJudge(options: {
  target: string; packet: SemanticPacket; directory: string; snapshot: string;
}) {
  const run = async (name:string, prompt:string, instructions:string, responseSchema:Record<string,unknown>) => {
    const result = await runLocal({
      target:options.target,effort:"medium",skillsRoot:options.snapshot,
      evalCase:{id:name,description:"Independent semantic assessment",prompt,fixture:{evidence:{}},expected:{}},
      instructions,transcript:join(options.directory,name==="semantic-review"?"native.jsonl":"claims-native.jsonl"),responseSchema,server:false,
    });
    await Bun.write(join(options.directory,name==="semantic-review"?"native-result.json":"claims-native-result.json"),JSON.stringify(result,null,2)+"\n");
    if (result.error) throw new Error(result.error);
    if (!result.responseModels.length || result.responseModels.some(model=>model!==parseModel(options.target).model)) throw new Error("Judge response-model identity missing or mismatched");
    if (result.ledger.events.length || result.ledger.actions.length || result.ledger.inspections.length || result.ledger.loadedSkills.length || result.ledger.loadedReferences.length || result.ledger.registeredSkillCalls.length || result.ledger.workers?.length)
      throw new Error("Tool-free judge unexpectedly produced tool evidence");
    return result;
  };
  const claimInput=JSON.stringify({sources:communicationSources(options.packet)});
  await Bun.write(join(options.directory,"claims-input.json"),claimInput);
  const extraction=await run("outcome-claims",claimInput,claimExtractionInstructions,extractionNativeSchema);
  const outcomeClaims=validateExtractedClaims(JSON.parse(extraction.output),options.packet);
  await Bun.write(join(options.directory,"claim-inventory.json"),JSON.stringify(outcomeClaims,null,2)+"\n");
  const input={packet:options.packet,acknowledgmentOnlyActions:acknowledgmentOnlyActions(options.packet),outcomeClaims};
  const serializedInput=JSON.stringify(input);
  const sha=(s:string)=>createHash("sha256").update(s).digest("hex");
  await Bun.write(join(options.directory,"review-input.json"),serializedInput);
  const result=await run("semantic-review",serializedInput,semanticInstructions+"\n\n"+outcomeReviewInstructions,semanticNativeSchema);
  return {
    review:validateOutcomeReview(JSON.parse(result.output),options.packet,outcomeClaims),
    actualJudgeModels:result.responseModels,actualExtractorModels:extraction.responseModels,
    reviewInputSha256:sha(serializedInput),claimInputSha256:sha(claimInput),outcomeClaimCount:outcomeClaims.length,
  };
}

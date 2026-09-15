import { isDeepStrictEqual } from "node:util";
import { parseModel } from "./local-runtime.ts";
import { issueWorkerReport, type IssueLiveConfig } from "./issue-live.ts";
import { verifyToolReceiptTranscript, verifyInterruptedToolReceiptTranscript } from "./tool-receipts.ts";
import type { RunLedger } from "./types.ts";

export function verifyIssueToolEvidence(
  config: IssueLiveConfig,
  parent: { ledger: RunLedger }, worker: any,
  parentRaw: string, workerRaw: string,
) {
  const parentCalls = verifyToolReceiptTranscript(parent.ledger, parseModel(config.parentModel).cli, parentRaw);
  if (!worker || worker.model !== config.workerModel)
    throw new Error("Missing or mismatched retained issue worker");
  const calls = parent.ledger.toolReceipts!.filter(r =>
    (r.request.params as any)?.name === "delegateIssue");
  if (calls.length !== 1) throw new Error("Expected one captured issue dispatch");
  const dispatch = calls[0]!;
  if (dispatch.state !== "completed" || dispatch.response.isError ||
    (dispatch.request.params as any)?.arguments?.context !== worker.context ||
    dispatch.response.content.length !== 1 ||
    !isDeepStrictEqual(JSON.parse(dispatch.response.content[0]!.text),
      JSON.parse(JSON.stringify(issueWorkerReport(worker)))))
    throw new Error("Issue dispatch does not bind the retained worker task and report");
  const cli = parseModel(config.workerModel).cli;
  if (config.fault === "interrupt-after-post") {
    if (!worker.interrupted || !worker.error)
      throw new Error("Incomplete receipt requires a retained interrupted worker");
    const evidence = verifyInterruptedToolReceiptTranscript(worker.ledger, cli, workerRaw);
    if ((evidence.incomplete.request.params as any)?.name !== "createIssue")
      throw new Error("Interruption did not capture the expected issue write");
    return { parentCalls, worker: evidence, dispatchBound: true };
  }
  if (worker.error || worker.interrupted)
    throw new Error("Expected a completed issue worker");
  return {
    parentCalls,
    worker: { completed: verifyToolReceiptTranscript(worker.ledger, cli, workerRaw) },
    dispatchBound: true,
  };
}

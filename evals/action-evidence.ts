import type { SemanticPacket } from "./semantic-review.ts";

export const recordedActionAcknowledgment = "Action recorded; no real external side effect occurred.";
export interface AcknowledgmentOnlyAction {
  actionSourceId: string;
  resultSourceId: string;
  action: string;
}

export function actionName(text: string): string | undefined {
  try {
    const data = JSON.parse(text);
    const name = data?.params?.name === "performAction" ? data.params.arguments?.action : data?.action;
    return typeof name === "string" ? name : undefined;
  } catch { return undefined; }
}

// Recognize only the fixture's exact recording acknowledgment, including its
// captured MCP envelope. Other returned text is not classified as success.
export function isRecordingAcknowledgment(text: string): boolean {
  if (text === recordedActionAcknowledgment) return true;
  try {
    let data = JSON.parse(text);
    if (data?.isError) return false;
    if (Array.isArray(data?.content)) {
      if (data.content.length !== 1 || data.content[0]?.type !== "text") return false;
      const content = data.content[0].text;
      if (content === recordedActionAcknowledgment) return true;
      data = JSON.parse(content);
    }
    return data?.ok === true && data?.isolated === true && data?.result === recordedActionAcknowledgment;
  } catch { return false; }
}

export function acknowledgmentOnlyActions(packet: SemanticPacket): AcknowledgmentOnlyAction[] {
  const sources = new Map(packet.sources.map(source => [source.id, source.text]));
  if (sources.size !== packet.sources.length) throw new Error("Duplicate packet source identity");
  const actions: AcknowledgmentOnlyAction[] = [];
  for (const source of packet.sources) {
    if (!source.id.startsWith("action:")) continue;
    const action = actionName(source.text);
    if (!action || ["report", "user.ask", "telemetry.append"].includes(action)) continue;
    const resultSourceId = source.id.replace(/^action:/, "result:");
    const result = sources.get(resultSourceId);
    if (result !== undefined && isRecordingAcknowledgment(result))
      actions.push({ actionSourceId: source.id, resultSourceId, action });
  }
  return actions;
}

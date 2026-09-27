import { isAbsolute, posix } from "node:path";
import type { RunLedger } from "./types.ts";
import { toolReceiptSchema } from "./tool-receipts.ts";

export interface SkillCitationRequirement { skill: string; passage: string }
const normalize = (text: string) => text.replace(/\s+/g, " ").trim();

function quotedPassages(text: string): string[] {
  const blocks = [...text.matchAll(/^(?: {0,3}>[^\n]*(?:\n|$))+/gm)]
    .map(match => match[0].replace(/^ {0,3}>\s?/gm, ""));
  const inline = [...text.matchAll(/"([^"]+)"|“([^”]+)”|`([^`]+)`/g)]
    .map(match => match[1] ?? match[2] ?? match[3]!);
  return [...blocks, ...inline].map(normalize);
}

function linkText(text: string): string {
  let fence: { marker: string; length: number } | undefined;
  return text.replace(/<!--[\s\S]*?(?:-->|$)/g, "").split("\n").map(line => {
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (fence) {
      if (marker && marker[1]![0] === fence.marker && marker[1]!.length >= fence.length && !marker[2]!.trim()) fence = undefined;
      return "";
    }
    if (marker) { fence = { marker: marker[1]![0]!, length: marker[1]!.length }; return ""; }
    return /^(?: {4}|\t)/.test(line) ? "" : line;
  }).join("\n").replace(/(`+)[\s\S]*?\1/g, "_");
}

// Inline Markdown links, including CommonMark's optional whitespace inside the
// parentheses, angle-wrapped destinations, and line or fragment suffixes. The
// destination must be absolute and resolve to the loaded source; bare paths and
// relative guesses are not links to the source this host supplied.
function linksTo(text: string, source: string): boolean {
  const target = posix.normalize(source);
  for (const match of text.matchAll(/(?<![!\\])\[[^\]\n]+\]\([ \t]*(?:<([^>\n]+)>|([^\s()<>]+))[ \t]*\)/g)) {
    const destination = (match[1] ?? match[2]!).replace(/(?::[1-9][0-9]*|#[^\s]+)$/, "");
    if (isAbsolute(destination) && posix.normalize(destination) === target) return true;
  }
  return false;
}

// This checks source identity and a required verbatim excerpt, not the truth or
// completeness of the surrounding explanation. Semantic review still applies.
export function hasSkillCitation(ledger: RunLedger, requirement: SkillCitationRequirement): boolean {
  if (ledger.toolReceiptVersion !== 1 || !ledger.toolReceipts ||
      !ledger.loadedSkills.includes(requirement.skill) || !requirement.passage.trim()) return false;
  const messages = ledger.actions.filter(a => a.action === "report" || a.action === "user.ask")
    .map(a => [a.details, a.data?.question, a.data?.body].filter(value => typeof value === "string").join("\n"));
  try {
    for (const raw of ledger.toolReceipts) {
      const receipt = toolReceiptSchema.parse(raw);
      if (receipt.state !== "completed" || receipt.response.isError || receipt.request.method !== "tools/call") continue;
      const params = receipt.request.params as { name?: string; arguments?: { name?: string } } | undefined;
      if (params?.name !== "loadSkill" || params.arguments?.name !== requirement.skill) continue;
      const result = JSON.parse(receipt.response.content[0]!.text);
      if (result.ok !== true || result.name !== requirement.skill || typeof result.path !== "string" ||
          !isAbsolute(result.path) || typeof result.instructions !== "string" ||
          !normalize(result.instructions).includes(normalize(requirement.passage))) continue;
      if (messages.some(message => linksTo(linkText(message), result.path) &&
        quotedPassages(message).some(quote => quote.includes(normalize(requirement.passage))))) return true;
    }
  } catch { return false; }
  return false;
}

import { link, mkdir, open, readFile, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { issueDigest } from "./issue-receipt.ts";

export async function readOperationIntent(path: string): Promise<unknown | undefined> {
  let raw: string;
  try { raw = await readFile(path, "utf8"); }
  catch (e: any) { if (e.code === "ENOENT") return undefined; throw e; }
  const value = JSON.parse(raw);
  if (value.schemaVersion !== 1 || !value.request || value.digest !== issueDigest(value.request))
    throw Error("Operation intent is corrupt");
  return value.request;
}
export async function matchingIntent(path: string, request: unknown) {
  const prior = await readOperationIntent(path);
  if (prior !== undefined && issueDigest(prior) !== issueDigest(request))
    throw Error("Operation intent belongs to a different request");
  return prior !== undefined;
}
// A permanent, exclusive mutation claim. Publish the complete file without
// replacing another coordinator's intent; a restart may reconcile, never reclaim.
export async function claimOperation(path: string, request: unknown) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const file = await open(temporary, "wx", 0o600);
  try {
    await file.writeFile(JSON.stringify({ schemaVersion: 1, request, digest: issueDigest(request) }));
    await file.sync();
  } finally { await file.close(); }
  try {
    try { await link(temporary, path); }
    catch (e: any) { if (e.code === "EEXIST") { await matchingIntent(path, request); return false; } throw e; }
    const dir = await open(dirname(path), "r");
    try { await dir.sync(); } finally { await dir.close(); }
    return true;
  } finally { await unlink(temporary); }
}

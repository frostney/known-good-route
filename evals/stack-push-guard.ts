import { resolve } from "node:path";
import { command } from "./github-live.ts";
import type { StackPublicationContext } from "./stack-publication.ts";

export interface PushGuardAdmission {
  directory: string; remote: string; url: string;
  refs: { ref: string; source: string; expected: string }[];
}
export const absentGitObject = "0".repeat(40);
export function stackPushAdmission(c: StackPublicationContext, head: string, phase: "submit" | "link"): PushGuardAdmission {
  return { directory: c.directory, remote: "origin", url: `https://github.com/${c.repository}.git`,
    refs: [...c.prefix.map(p => ({ ref: `refs/heads/${p.branch}`, source: p.head, expected: p.head })),
      { ref: `refs/heads/${c.branch}`, source: head, expected: phase === "submit" ? absentGitObject : head }] };
}

export async function preparePushGuard(admission: PushGuardAdmission) {
  const helper = resolve(import.meta.dir, "../git-workflow/scripts/stack_push_guard.py");
  const prepared = JSON.parse(await command([process.env.KGR_PYTHON_BIN ?? "python3", helper, "prepare", "--admission", "-"],
    admission.directory, JSON.stringify(admission)));
  return { directory: prepared.directory as string, environment: { ...process.env, ...prepared.configuration } };
}

export async function runGuardedStack(admission: PushGuardAdmission, args: string[], python = process.env.KGR_PYTHON_BIN ?? "python3",
  environment?: NodeJS.ProcessEnv) {
  const helper = resolve(import.meta.dir, "../git-workflow/scripts/stack_push_guard.py");
  await command([python, helper, "run", "--admission", "-", "--", "gh", "stack", ...args], admission.directory, JSON.stringify(admission), environment);
}

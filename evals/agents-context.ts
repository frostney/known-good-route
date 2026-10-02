import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
  AGENTS_FILE,
  INSTALLED_SKILLS_DIRECTORY,
  writeAgentsBlock,
} from "../.github/actions/update-project-skills/agents-block.mjs";
import type { LoadedSkill } from "./skill-loader.ts";
import type { EvalCase, EvalEnvironment } from "./types.ts";

// The files a case's declared environment puts in the repository root.
export function environmentFiles(environment: EvalEnvironment | undefined): Record<string, string> {
  if (!environment) return {};
  const files: Record<string, string> = {};
  const orchestration = environment.orchestration;
  if (orchestration)
    files["ORCHESTRATION.md"] = [
      "---",
      `endpoint: ${orchestration.endpoint}`,
      `entry-points: ${orchestration.entryPoints}`,
      "---",
      "",
      "# Orchestration",
      "",
      ...(orchestration.body ? [orchestration.body.trim(), ""] : []),
    ].join("\n");
  return { ...files, ...(environment.files ?? {}) };
}

export async function writeFiles(root: string, files: Record<string, string>) {
  for (const [path, content] of Object.entries(files)) {
    if (path.startsWith("/") || path.split("/").includes(".."))
      throw new Error(`Environment file escapes the workspace: ${path}`);
    await mkdir(dirname(join(root, path)), { recursive: true });
    await Bun.write(join(root, path), content);
  }
}

// Exactly what a run of this case sees and what its record exposes: the
// configuration files written into the workspace, the AGENTS.md block
// generated beside them, and the case's repository evidence.
export async function caseEnvironment(
  evalCase: EvalCase,
  agentsFor: (files: Record<string, string>) => Promise<string>,
) {
  const files = environmentFiles(evalCase.fixture.environment);
  return { files, agentsMd: await agentsFor(files), repoContext: evalCase.fixture.evidence };
}

// The AGENTS.md a consuming repository would carry for exactly these installed
// skills and this repository configuration, produced by the same generator the
// skills update runs. The configuration files sit in the project root the
// generator reads.
export async function agentsFileFor(
  skills: Map<string, LoadedSkill>,
  files: Record<string, string> = {},
): Promise<string> {
  const project = await mkdtemp(join(tmpdir(), "kgr-agents-"));
  try {
    await writeFiles(project, files);
    for (const skill of skills.values()) {
      const directory = join(project, INSTALLED_SKILLS_DIRECTORY, basename(skill.directory));
      await mkdir(directory, { recursive: true });
      await Bun.write(join(directory, "SKILL.md"), skill.body);
    }
    await writeAgentsBlock(project);
    const file = Bun.file(join(project, AGENTS_FILE));
    return (await file.exists()) ? await file.text() : "";
  } finally {
    await rm(project, { recursive: true, force: true });
  }
}

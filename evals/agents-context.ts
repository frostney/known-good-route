import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  AGENTS_FILE,
  INSTALLED_SKILLS_DIRECTORY,
  writeAgentsBlock,
} from "../.github/actions/update-project-skills/agents-block.mjs";
import type { LoadedSkill } from "./skill-loader.ts";

// The AGENTS.md a consuming repository would carry for exactly these installed
// skills, produced by the same generator the skills update runs.
export async function agentsFileFor(
  skills: Map<string, LoadedSkill>,
): Promise<string> {
  const project = await mkdtemp(join(tmpdir(), "kgr-agents-"));
  try {
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

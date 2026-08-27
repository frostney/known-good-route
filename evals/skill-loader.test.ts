import { describe, expect, test } from "bun:test";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  formatSkillCatalog,
  loadSkills,
  readSkillReference,
  validateSkillReferences,
} from "./skill-loader.ts";

const repositoryRoot = resolve(import.meta.dir, "..");

describe("skill loader", () => {
  test("discovers every top-level skill", async () => {
    const skills = await loadSkills(repositoryRoot);

    expect(skills.size).toBe(28);
    expect(skills.has("address-stack-feedback")).toBeTrue();
    expect(skills.has("agent-writing")).toBeTrue();
    expect(skills.has("agent-behavior-audit")).toBeTrue();
    expect(skills.has("code-review")).toBeTrue();
    expect(skills.has("codebase-audit")).toBeTrue();
    expect(skills.has("create-pr")).toBeTrue();
    expect(skills.has("milestone-rush")).toBeTrue();
    expect(skills.has("maintain-project-skills")).toBeTrue();
    expect(skills.has("delivery-wait")).toBeTrue();
    expect(skills.has("run-retro")).toBeTrue();
    expect(skills.has("render-html")).toBeTrue();
    expect(skills.has("status-report")).toBeTrue();
    expect(skills.has("test-against-spec")).toBeTrue();
    expect(skills.has("typescript-stack")).toBeTrue();
    expect(formatSkillCatalog(skills)).toContain("<available_skills>");
  });

  test("validates and contains routed references", async () => {
    const skills = await loadSkills(repositoryRoot);
    const references = await validateSkillReferences(skills);

    expect(references.length).toBeGreaterThan(0);
    const projectStructure = skills.get("project-structure");
    expect(projectStructure).toBeDefined();
    if (!projectStructure) {
      return;
    }

    const content = await readSkillReference(
      projectStructure,
      "references/documentation.md",
    );
    expect(content).toContain("# Documentation and repository templates");
    expect(
      readSkillReference(projectStructure, "../README.md"),
    ).rejects.toThrow("escapes");
  });

  test("keeps the project-skills runbook inside a standalone skill copy", async () => {
    const installationRoot = await mkdtemp(
      join(tmpdir(), "kgr-installed-skills-"),
    );
    const installedSkill = join(installationRoot, "maintain-project-skills");

    try {
      await cp(join(repositoryRoot, "maintain-project-skills"), installedSkill, {
        recursive: true,
      });
      const skills = await loadSkills(installationRoot);
      expect(await validateSkillReferences(skills)).toEqual([
        "maintain-project-skills/references/project-skills-runbook.md",
      ]);

      const skill = skills.get("maintain-project-skills");
      expect(skill).toBeDefined();
      if (!skill) {
        return;
      }
      expect(skill.body).not.toContain("../docs/");
      const runbook = await readSkillReference(
        skill,
        "references/project-skills-runbook.md",
      );
      expect(runbook).toContain("`actions: read`");
      expect(runbook).toContain("full 40-character SHA");
    } finally {
      await rm(installationRoot, { force: true, recursive: true });
    }
  });
});

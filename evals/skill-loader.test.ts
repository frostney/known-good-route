import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
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

    expect(skills.size).toBe(21);
    expect(skills.has("code-review")).toBeTrue();
    expect(skills.has("codebase-audit")).toBeTrue();
    expect(skills.has("create-pr")).toBeTrue();
    expect(skills.has("milestone-rush")).toBeTrue();
    expect(skills.has("delivery-wait")).toBeTrue();
    expect(skills.has("run-retro")).toBeTrue();
    expect(skills.has("status-report")).toBeTrue();
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
});

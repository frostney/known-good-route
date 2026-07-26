import { readdir } from "node:fs/promises";
import { isAbsolute, join, normalize, relative, resolve } from "node:path";
import { parse as parseYaml } from "yaml";

export interface LoadedSkill {
  name: string;
  description: string;
  directory: string;
  body: string;
}

interface SkillFrontmatter {
  name?: unknown;
  description?: unknown;
}

function splitFrontmatter(source: string): {
  frontmatter: SkillFrontmatter;
  body: string;
} {
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match?.[1] || match[2] === undefined) {
    throw new Error("SKILL.md is missing YAML frontmatter");
  }

  return {
    frontmatter: parseYaml(match[1]) as SkillFrontmatter,
    body: match[2],
  };
}

export async function loadSkills(root: string): Promise<Map<string, LoadedSkill>> {
  const rootPath = resolve(root);
  const entries = await readdir(rootPath, { withFileTypes: true });
  const skills = new Map<string, LoadedSkill>();

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) {
      continue;
    }

    const directory = join(rootPath, entry.name);
    const skillPath = join(directory, "SKILL.md");
    const file = Bun.file(skillPath);
    if (!(await file.exists())) {
      continue;
    }

    const source = await file.text();
    const { frontmatter } = splitFrontmatter(source);
    if (
      typeof frontmatter.name !== "string" ||
      typeof frontmatter.description !== "string"
    ) {
      throw new Error(`${skillPath} needs string name and description fields`);
    }
    if (skills.has(frontmatter.name)) {
      throw new Error(`Duplicate skill name: ${frontmatter.name}`);
    }

    skills.set(frontmatter.name, {
      name: frontmatter.name,
      description: frontmatter.description,
      directory,
      body: source,
    });
  }

  return skills;
}

export function formatSkillCatalog(skills: Map<string, LoadedSkill>): string {
  const items = [...skills.values()]
    .sort((left, right) => left.name.localeCompare(right.name))
    .map(
      (skill) =>
        `<skill><name>${skill.name}</name><description>${skill.description}</description></skill>`,
    );

  return `<available_skills>\n${items.join("\n")}\n</available_skills>`;
}

export async function readSkillReference(
  skill: LoadedSkill,
  referencePath: string,
): Promise<string> {
  if (isAbsolute(referencePath)) {
    throw new Error("Skill references must be relative");
  }

  const normalizedPath = normalize(referencePath);
  const absolutePath = resolve(skill.directory, normalizedPath);
  const containedPath = relative(skill.directory, absolutePath);
  if (containedPath.startsWith("..") || isAbsolute(containedPath)) {
    throw new Error("Skill reference escapes its skill directory");
  }

  const file = Bun.file(absolutePath);
  if (!(await file.exists())) {
    throw new Error(`Missing skill reference: ${skill.name}/${referencePath}`);
  }

  return file.text();
}

export async function validateSkillReferences(
  skills: Map<string, LoadedSkill>,
): Promise<string[]> {
  const checked: string[] = [];
  const referencePattern = /\]\((references\/[^)]+)\)/g;

  for (const skill of skills.values()) {
    for (const match of skill.body.matchAll(referencePattern)) {
      const referencePath = match[1];
      if (!referencePath) {
        continue;
      }
      await readSkillReference(skill, referencePath);
      checked.push(`${skill.name}/${referencePath}`);
    }
  }

  return checked.sort();
}

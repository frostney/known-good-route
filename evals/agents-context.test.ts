import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  MARKER_BEGIN,
  MARKER_END,
} from "../.github/actions/update-project-skills/agents-block.mjs";
import { agentsFileFor } from "./agents-context.ts";
import { portableAgentInstructions } from "./run.ts";
import { loadSkills } from "./skill-loader.ts";

const skill = (name: string, metadata = "") =>
  `---\nname: ${name}\ndescription: ${name} skill.\n${metadata}---\n\n# ${name}\n`;

async function skillsRoot(files: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), "kgr-agents-skills-"));
  for (const [name, source] of Object.entries(files)) {
    await mkdir(join(root, name));
    await Bun.write(join(root, name, "SKILL.md"), source);
  }
  return root;
}

test("each run's AGENTS.md block lists exactly the installed skills' declared roles", async () => {
  const root = await skillsRoot({
    "zeta-entry": skill("zeta-entry", "metadata:\n  agents-role: entry-point\n  agents-text: Start delivery here.\n"),
    "alpha-ambient": skill("alpha-ambient", "metadata:\n  agents-role: ambient\n  agents-text: Hold this standard.\n"),
    "no-role": skill("no-role"),
  });
  try {
    const file = await agentsFileFor(await loadSkills(root));
    expect(file).toContain(MARKER_BEGIN);
    expect(file).toContain(MARKER_END);
    expect(file).toContain("- Always apply `alpha-ambient`: Hold this standard.");
    expect(file).toContain("- Start with `/zeta-entry`: Start delivery here.");
    expect(file).not.toContain("no-role");
    // Ambient skills come before entry points, as the generator orders them.
    expect(file.indexOf("alpha-ambient")).toBeLessThan(file.indexOf("zeta-entry"));
    const instructions = portableAgentInstructions("<catalog/>", file);
    expect(instructions).toContain(`<agents-md>\n${file.trim()}\n</agents-md>`);
    expect(portableAgentInstructions("<catalog/>")).not.toContain("<agents-md>");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a run whose installed skills declare no role carries no AGENTS.md block", async () => {
  const root = await skillsRoot({ plain: skill("plain") });
  try {
    expect(await agentsFileFor(await loadSkills(root))).toBe("");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the repository's own skills produce the block the generator writes for them", async () => {
  const file = await agentsFileFor(await loadSkills(resolve(import.meta.dir, "..")));
  expect(file).toContain("- Start with `/deliver`:");
  expect(file).toContain("- Always apply `software-engineering-excellence`:");
});

test("a frozen snapshot carries every file the harness imports from outside evals/", async () => {
  const { harnessSupportFiles } = await import("./snapshot.ts");
  const root = resolve(import.meta.dir, "..");
  const glob = new Bun.Glob("*.ts");
  for await (const name of glob.scan(import.meta.dir)) {
    if (name.endsWith(".test.ts")) continue;
    const source = await Bun.file(join(import.meta.dir, name)).text();
    for (const [, target] of source.matchAll(/from "(\.\.\/[^"]+)"/g)) {
      const path = resolve(import.meta.dir, target!).slice(root.length + 1);
      expect(harnessSupportFiles, `${name} imports ${path}`).toContain(path);
      const declaration = path.replace(/\.mjs$/, ".d.mts");
      if (declaration !== path) expect(harnessSupportFiles).toContain(declaration);
    }
  }
});

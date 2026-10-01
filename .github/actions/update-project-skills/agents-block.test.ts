import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readlink, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  MARKER_BEGIN,
  MARKER_END,
  collectSkillRoles,
  verifyAgentsBlock,
  writeAgentsBlock,
} from "./agents-block.mjs";

const temporaryDirectories: string[] = [];
const runtime = fileURLToPath(new URL("./update-project-skills.mjs", import.meta.url));

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

async function makeProject() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "kgr-agents-block-")));
  temporaryDirectories.push(root);
  return root;
}

async function installSkill(root: string, name: string, metadata: string | null) {
  const directory = join(root, ".agents", "skills", name);
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, "SKILL.md"),
    [
      "---",
      `name: ${name}`,
      "description: >-",
      "  Invented fixture skill.",
      "license: Unlicense OR MIT",
      ...(metadata === null ? [] : ["metadata:", metadata]),
      "---",
      "",
      `# ${name}`,
      "",
    ].join("\n"),
  );
}

async function installFixturePack(root: string) {
  await installSkill(root, "ship-widget", '  agents-role: entry-point\n  agents-text: "Carry one widget change to a verified release."');
  await installSkill(root, "tidy-notes", "  agents-role: ambient\n  agents-text: Keep every note short and sourced.");
  await installSkill(root, "brew-tea", "  agents-role: 'entry-point'\n  agents-text: 'Brew the team''s pot.' # trailing comment");
  await installSkill(root, "plain-helper", null);
  await installSkill(root, "tagged-helper", "  author: someone-invented");
}

const fixtureRegion = [
  MARKER_BEGIN,
  "",
  "## Agent skills",
  "",
  "Generated from the `metadata.agents-role` and `metadata.agents-text` of the skills installed in `.agents/skills`. Edit outside the `known-good-route:agents` markers only.",
  "",
  "- Always apply `tidy-notes`: Keep every note short and sourced.",
  "- Start with `/brew-tea`: Brew the team's pot.",
  "- Start with `/ship-widget`: Carry one widget change to a verified release.",
  "",
  MARKER_END,
].join("\n");

const agentsFile = (root: string) => join(root, "AGENTS.md");

describe("installed skill roles", () => {
  test("collects declared roles from the installed skills and leaves undeclared skills out", async () => {
    const root = await makeProject();
    await installFixturePack(root);
    expect(await collectSkillRoles(root)).toEqual([
      { name: "tidy-notes", role: "ambient", text: "Keep every note short and sourced." },
      { name: "brew-tea", role: "entry-point", text: "Brew the team's pot." },
      { name: "ship-widget", role: "entry-point", text: "Carry one widget change to a verified release." },
    ]);
  });

  test("rejects a declaration it cannot render as one line", async () => {
    const cases: [string, string][] = [
      ["  agents-role: always\n  agents-text: Unknown role.", 'declares agents-role "always"'],
      ["  agents-role: ambient", "declares agents-role without agents-text"],
      ["  agents-role: ambient\n  agents-text: >-\n    Folded text.", "must be a single-line value"],
      ["  agents-text: Text without a role.", 'declares agents-role ""'],
    ];
    for (const [metadata, message] of cases) {
      const root = await makeProject();
      await installSkill(root, "odd-skill", metadata);
      await expect(collectSkillRoles(root)).rejects.toThrow(message);
    }
  });
});

describe("AGENTS.md block", () => {
  test("creates a minimal AGENTS.md when none exists and the pack declares roles", async () => {
    const root = await makeProject();
    await installFixturePack(root);
    expect((await verifyAgentsBlock(root)).inSync).toBe(false);
    await expect(stat(agentsFile(root))).rejects.toThrow();

    expect((await writeAgentsBlock(root)).changed).toBe(true);
    expect(await readFile(agentsFile(root), "utf8")).toBe(`# Agent Instructions\n\n${fixtureRegion}\n`);
    expect((await verifyAgentsBlock(root)).inSync).toBe(true);
  });

  test("leaves a project without declared roles and without a block untouched", async () => {
    const root = await makeProject();
    await installSkill(root, "plain-helper", null);
    expect((await writeAgentsBlock(root)).changed).toBe(false);
    await expect(stat(agentsFile(root))).rejects.toThrow();
    expect((await verifyAgentsBlock(root)).inSync).toBe(true);

    await writeFile(agentsFile(root), "# House rules\n");
    expect((await writeAgentsBlock(root)).changed).toBe(false);
    expect(await readFile(agentsFile(root), "utf8")).toBe("# House rules\n");
  });

  test("appends after the existing text and keeps its bytes exactly", async () => {
    for (const [existing, separator] of [
      ["# House rules\r\n\r\nUse CRLF prose.\r\n", "\n"],
      ["# House rules\n\nNo final newline", "\n\n"],
      ["# House rules\n\n", ""],
    ]) {
      const root = await makeProject();
      await installFixturePack(root);
      await writeFile(agentsFile(root), existing);
      await writeAgentsBlock(root);
      expect(await readFile(agentsFile(root), "utf8")).toBe(`${existing}${separator}${fixtureRegion}\n`);
    }
  });

  test("replaces only the fenced region, keeps the text around it, and is stable on a second run", async () => {
    const root = await makeProject();
    await installFixturePack(root);
    const before = `# House rules\r\n\r\nMentioning ${MARKER_BEGIN} mid-line is prose.\r\n\r\n`;
    const after = "\r\n## After the block\r\n\r\nHand-written tail.";
    await writeFile(agentsFile(root), `${before}${MARKER_BEGIN}\nstale hand edit\n${MARKER_END}${after}`);

    expect((await writeAgentsBlock(root)).changed).toBe(true);
    const first = await readFile(agentsFile(root), "utf8");
    expect(first).toBe(`${before}${fixtureRegion}${after}`);

    expect((await writeAgentsBlock(root)).changed).toBe(false);
    expect(await readFile(agentsFile(root), "utf8")).toBe(first);
  });

  test("keeps an existing block and says no role is declared when the roles go away", async () => {
    const root = await makeProject();
    await installSkill(root, "plain-helper", null);
    await writeFile(agentsFile(root), `# House rules\n\n${MARKER_BEGIN}\nold\n${MARKER_END}\n`);
    await writeAgentsBlock(root);
    expect(await readFile(agentsFile(root), "utf8")).toContain("No installed skill declares `metadata.agents-role`.");
  });

  test("verify fails on drift without writing and passes once in sync", async () => {
    const root = await makeProject();
    await installFixturePack(root);
    await writeAgentsBlock(root);
    expect((await verifyAgentsBlock(root)).inSync).toBe(true);

    const handEdited = (await readFile(agentsFile(root), "utf8")).replace("Brew the team's pot.", "Brew coffee.");
    await writeFile(agentsFile(root), handEdited);
    expect((await verifyAgentsBlock(root)).inSync).toBe(false);
    expect(await readFile(agentsFile(root), "utf8")).toBe(handEdited);

    await writeAgentsBlock(root);
    await installSkill(root, "file-taxes", "  agents-role: entry-point\n  agents-text: File the yearly return.");
    expect((await verifyAgentsBlock(root)).inSync).toBe(false);
    await writeAgentsBlock(root);
    expect((await verifyAgentsBlock(root)).inSync).toBe(true);
  });

  test("refuses a lone, duplicated, or out-of-order marker instead of guessing", async () => {
    for (const content of [
      `${MARKER_BEGIN}\nonly a start\n`,
      `${MARKER_END}\n${MARKER_BEGIN}\n`,
      `${MARKER_BEGIN}\n${MARKER_END}\n${MARKER_BEGIN}\n${MARKER_END}\n`,
    ]) {
      const root = await makeProject();
      await installFixturePack(root);
      await writeFile(agentsFile(root), content);
      await expect(writeAgentsBlock(root)).rejects.toThrow("AGENTS.md");
      expect(await readFile(agentsFile(root), "utf8")).toBe(content);
    }
  });

  test("refuses to replace a symlinked AGENTS.md with a regular file", async () => {
    const root = await makeProject();
    await installFixturePack(root);
    await writeFile(join(root, "CLAUDE.md"), "# House rules\n");
    await symlink("CLAUDE.md", agentsFile(root));
    await expect(writeAgentsBlock(root)).rejects.toThrow("is a symlink");
    expect(await readlink(agentsFile(root))).toBe("CLAUDE.md");
    expect(await readFile(join(root, "CLAUDE.md"), "utf8")).toBe("# House rules\n");
  });

  test("writes and verifies through the Node entrypoint with matching exit codes", async () => {
    const root = await makeProject();
    await installFixturePack(root);
    const run = (command: string) =>
      spawnSync("node", [runtime, command, "--repository-root", root, "--skills-root", "."], { encoding: "utf8" });

    const stale = run("verify-agents-block");
    expect(stale.status).toBe(1);
    expect(stale.stderr).toContain("skills block is stale");
    expect(run("write-agents-block").status).toBe(0);
    expect(run("verify-agents-block").status).toBe(0);
  });
});

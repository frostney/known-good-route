import { afterEach, describe, expect, test } from "bun:test";
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { parse } from "yaml";

import {
  ProjectSkillsError,
  computeSkillDirectoryHash,
  inspectInventory,
  parseDeletedSkillWarnings,
  publishProjectSkills,
  refreshProjectSkills,
} from "./update-project-skills.mjs";

const temporaryDirectories: string[] = [];
const repositoryRoot = new URL("../../..", import.meta.url).pathname.replace(/\/$/, "");

function runGit(root: string, args: string[]) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
  return result.stdout.trim();
}

async function makeRepository(skillsRoot = ".", skillName = "example-skill") {
  const created = await mkdtemp(join(tmpdir(), "kgr-skills-test-"));
  const root = await realpath(created);
  temporaryDirectories.push(root);
  runGit(root, ["init", "--initial-branch=main"]);
  runGit(root, ["config", "user.name", "Test"]);
  runGit(root, ["config", "user.email", "test@example.com"]);
  const projectRoot = skillsRoot === "." ? root : join(root, skillsRoot);
  const skillDirectory = join(projectRoot, ".agents", "skills", skillName);
  await mkdir(skillDirectory, { recursive: true });
  await writeFile(
    join(skillDirectory, "SKILL.md"),
    `---\nname: ${skillName}\ndescription: Test fixture.\n---\n\n# Fixture\n`,
  );
  await writeInventory(projectRoot, skillName);
  runGit(root, ["add", "."]);
  runGit(root, ["commit", "--message", "test: add fixture inventory"]);
  return { projectRoot, root, skillDirectory, skillName, skillsRoot };
}

async function writeInventory(projectRoot: string, skillName: string, overrides = {}) {
  const skillDirectory = join(projectRoot, ".agents", "skills", skillName);
  const lock = {
    version: 1,
    skills: {
      [skillName]: {
        source: "example/skills",
        sourceType: "github",
        skillPath: `skills/${skillName}/SKILL.md`,
        computedHash: await computeSkillDirectoryHash(skillDirectory),
        ...overrides,
      },
    },
  };
  await writeFile(
    join(projectRoot, "skills-lock.json"),
    `${JSON.stringify(lock, null, 2)}\n`,
  );
}

async function refreshOptions(fixture: Awaited<ReturnType<typeof makeRepository>>) {
  const artifactDirectory = join(fixture.root, "..", `${fixture.skillName}-artifact-${Date.now()}`);
  temporaryDirectories.push(artifactDirectory);
  return {
    artifactDirectory,
    cliVersion: "1.5.17",
    normalizeLockHashes: false,
    repairFindSkills: false,
    repositoryRoot: fixture.root,
    skillsRoot: fixture.skillsRoot,
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) =>
      rm(path, { force: true, recursive: true }),
    ),
  );
});

describe("project inventory validation", () => {
  test("validates canonical root and nested inventories", async () => {
    const rootFixture = await makeRepository();
    const nestedFixture = await makeRepository("paddy");

    expect((await inspectInventory(rootFixture.projectRoot)).names).toEqual([
      "example-skill",
    ]);
    expect((await inspectInventory(nestedFixture.projectRoot)).names).toEqual([
      "example-skill",
    ]);
  });

  test("rejects a missing inventory and a blocked source", async () => {
    const missing = await makeRepository();
    await rm(join(missing.projectRoot, "skills-lock.json"));
    await expect(inspectInventory(missing.projectRoot)).rejects.toThrow(
      "Project inventory is missing",
    );

    const blocked = await makeRepository();
    await writeInventory(blocked.projectRoot, blocked.skillName, {
      sourceType: "local",
    });
    await expect(inspectInventory(blocked.projectRoot)).rejects.toThrow(
      "sourceType local cannot be refreshed remotely",
    );
  });

  test("rejects an invalid content hash when normalization is off", async () => {
    const fixture = await makeRepository();
    const lockPath = join(fixture.projectRoot, "skills-lock.json");
    const lock = JSON.parse(await readFile(lockPath, "utf8"));
    lock.skills[fixture.skillName].computedHash = "0".repeat(64);
    await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`);

    await expect(inspectInventory(fixture.projectRoot)).rejects.toThrow(
      "Canonical content hash mismatch",
    );
  });
});

describe("project refresh", () => {
  test("emits a no-change artifact without touching the repository", async () => {
    const fixture = await makeRepository();
    const options = await refreshOptions(fixture);
    const result = await refreshProjectSkills(options, {
      runSkills: () => ({ status: 0, output: "All project skills are up to date" }),
    });

    expect(result.changed).toBe(false);
    expect(result.changedPaths).toEqual([]);
    const metadata = JSON.parse(
      await readFile(join(options.artifactDirectory, "metadata.json"), "utf8"),
    );
    expect(metadata.changed).toBe(false);
    expect(await readFile(join(options.artifactDirectory, "skills-update.patch"), "utf8")).toBe("");
  });

  test("captures changed and untracked generated files at a nested root", async () => {
    const fixture = await makeRepository("paddy");
    const options = await refreshOptions(fixture);
    const result = await refreshProjectSkills(options, {
      runSkills: async () => {
        await writeFile(join(fixture.skillDirectory, "reference.md"), "updated\n");
        await writeInventory(fixture.projectRoot, fixture.skillName);
        return { status: 0, output: "Updated 1 skill" };
      },
    });

    expect(result.changed).toBe(true);
    expect(result.changedPaths).toContain(
      "paddy/.agents/skills/example-skill/reference.md",
    );
    expect(result.scopedPaths).toEqual([
      "paddy/.agents/skills",
      "paddy/skills-lock.json",
    ]);
    const patch = await readFile(
      join(options.artifactDirectory, "skills-update.patch"),
      "utf8",
    );
    expect(patch).toContain("reference.md");
    expect(patch).toContain("skills-lock.json");

    const applyDirectory = await realpath(
      await mkdtemp(join(tmpdir(), "kgr-skills-apply-test-")),
    );
    temporaryDirectories.push(applyDirectory);
    runGit(applyDirectory, ["clone", fixture.root, "."]);
    runGit(applyDirectory, [
      "apply",
      "--index",
      "--binary",
      join(options.artifactDirectory, "skills-update.patch"),
    ]);
    await expect(
      inspectInventory(join(applyDirectory, "paddy")),
    ).resolves.toBeDefined();
    expect(
      await readFile(
        join(
          applyDirectory,
          "paddy/.agents/skills/example-skill/reference.md",
        ),
        "utf8",
      ),
    ).toBe("updated\n");
  });

  test("normalizes canonical hashes only when enabled", async () => {
    const fixture = await makeRepository();
    const lockPath = join(fixture.projectRoot, "skills-lock.json");
    const lock = JSON.parse(await readFile(lockPath, "utf8"));
    lock.skills[fixture.skillName].computedHash = "0".repeat(64);
    await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
    runGit(fixture.root, ["add", "."]);
    runGit(fixture.root, ["commit", "--message", "test: add invalid hash"]);
    const offOptions = await refreshOptions(fixture);
    await expect(
      refreshProjectSkills(offOptions, {
        runSkills: () => ({ status: 0, output: "no change" }),
      }),
    ).rejects.toThrow("Canonical content hash mismatch");

    const onOptions = {
      ...(await refreshOptions(fixture)),
      normalizeLockHashes: true,
    };
    const result = await refreshProjectSkills(onOptions, {
      runSkills: () => ({ status: 0, output: "no change" }),
    });
    expect(result.changed).toBe(true);
    await expect(inspectInventory(fixture.projectRoot)).resolves.toBeDefined();
  });

  test("blocks deleted skills and narrowly repairs find-skills", async () => {
    const warning = `Warning: The following skills from vercel-labs/skills appear to have been deleted upstream:\n  • find-skills\nSkipping deletion in non-interactive mode.`;
    expect(parseDeletedSkillWarnings(warning)).toEqual(["find-skills"]);

    const blocked = await makeRepository(".", "find-skills");
    const blockedOptions = await refreshOptions(blocked);
    await expect(
      refreshProjectSkills(blockedOptions, {
        runSkills: () => ({ status: 0, output: warning }),
      }),
    ).rejects.toThrow("blocked by deleted or renamed upstream skills");

    const repaired = await makeRepository(".", "find-skills");
    const repairedOptions = {
      ...(await refreshOptions(repaired)),
      repairFindSkills: true,
    };
    const calls: string[][] = [];
    await refreshProjectSkills(repairedOptions, {
      runSkills: (args: string[]) => {
        calls.push(args);
        return {
          status: 0,
          output: calls.length === 1 ? warning : "Installed find-skills",
        };
      },
    });
    expect(calls[0]).toEqual(["update", "--project", "--yes"]);
    expect(calls[1]).toContain("--full-depth");
    expect(calls[1]).not.toContain("-g");
  });

  test("publishes the artifact as an always-new draft branch commit", async () => {
    const fixture = await makeRepository();
    const bareRemote = await realpath(
      await mkdtemp(join(tmpdir(), "kgr-skills-remote-test-")),
    );
    temporaryDirectories.push(bareRemote);
    runGit(bareRemote, ["init", "--bare"]);
    runGit(fixture.root, ["remote", "add", "origin", bareRemote]);
    runGit(fixture.root, ["push", "--set-upstream", "origin", "main"]);

    const options = await refreshOptions(fixture);
    await refreshProjectSkills(options, {
      runSkills: async () => {
        await writeFile(join(fixture.skillDirectory, "reference.md"), "published\n");
        await writeInventory(fixture.projectRoot, fixture.skillName);
        return { status: 0, output: "Updated 1 skill" };
      },
    });

    const publishRoot = await realpath(
      await mkdtemp(join(tmpdir(), "kgr-skills-publish-test-")),
    );
    temporaryDirectories.push(publishRoot);
    runGit(publishRoot, ["clone", bareRemote, "."]);
    const fakeBin = await realpath(
      await mkdtemp(join(tmpdir(), "kgr-skills-gh-test-")),
    );
    temporaryDirectories.push(fakeBin);
    const fakeGh = join(fakeBin, "gh");
    await writeFile(
      fakeGh,
      "#!/bin/sh\nif [ \"$1 $2\" = \"pr list\" ]; then printf '[]\\n'; else printf 'https://example.test/pull/1\\n'; fi\n",
    );
    await chmod(fakeGh, 0o755);
    const previousPath = process.env.PATH;
    process.env.PATH = `${fakeBin}:${previousPath}`;
    try {
      const result = await publishProjectSkills({
        artifactDirectory: options.artifactDirectory,
        body: "Generated update.",
        branch: "automation/update-agent-skills",
        repositoryRoot: publishRoot,
        title: "chore(skills): refresh project Agent Skills",
      });
      expect(result.pullRequestUrl).toBe("https://example.test/pull/1");
      expect(result.headSha).not.toBe(runGit(publishRoot, ["rev-parse", "main"]));
      expect(
        runGit(bareRemote, [
          "rev-parse",
          "refs/heads/automation/update-agent-skills^",
        ]),
      ).toBe(runGit(bareRemote, ["rev-parse", "refs/heads/main"]));
    } finally {
      process.env.PATH = previousPath;
    }
  });
});

describe("workflow contracts", () => {
  test("keeps immutable helper resolution and split job permissions", async () => {
    const workflowPath = join(
      repositoryRoot,
      ".github/workflows/update-project-skills.yml",
    );
    const raw = await readFile(workflowPath, "utf8");
    const workflow = parse(raw);

    expect(workflow.on.workflow_call.inputs["skills-root"].default).toBe(".");
    expect(workflow.on.workflow_call.inputs["skills-cli-version"].default).toBe(
      "1.5.17",
    );
    expect(
      workflow.on.workflow_call.inputs["normalize-lock-hashes"].default,
    ).toBe(false);
    expect(workflow.jobs.refresh.permissions).toEqual({ contents: "read" });
    expect(workflow.jobs.publish.permissions).toEqual({
      contents: "write",
      "pull-requests": "write",
    });
    expect(raw).toContain("uses: $/.github/actions/update-project-skills");
    expect(raw).not.toContain("uses: ./.github/actions/update-project-skills");
    expect(raw).not.toContain("repository: frostney/known-good-route");
    expect(raw).not.toMatch(/\bmerge\b/);
    expect(raw).toContain("actions/upload-artifact@");
    expect(raw).toContain("actions/download-artifact@");
    const actionlintConfig = await readFile(
      join(repositoryRoot, ".github/actionlint.yaml"),
      "utf8",
    );
    expect(actionlintConfig).toContain(
      'specifying action "\\$/\\.github/actions/update-project-skills"',
    );
    const action = parse(
      await readFile(
        join(
          repositoryRoot,
          ".github/actions/update-project-skills/action.yml",
        ),
        "utf8",
      ),
    );
    expect(action.outputs.head_sha.value).toContain("publish_runtime");
    expect(action.outputs.pr_url.value).toContain("publish_runtime");
    const runtime = await readFile(
      join(
        repositoryRoot,
        ".github/actions/update-project-skills/update-project-skills.mjs",
      ),
      "utf8",
    );
    expect(runtime).not.toContain("force-with-lease");
    expect(runtime).not.toMatch(/\["push",\s*"--force/);
  });

  test("keeps every third-party workflow action pinned to a full SHA", async () => {
    const raw = await readFile(
      join(repositoryRoot, ".github/workflows/update-project-skills.yml"),
      "utf8",
    );
    const externalUses = [
      ...raw.matchAll(
        /^\s*uses:\s+([A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+@[a-f0-9]+)\s*(?:#.*)?$/gm,
      ),
    ].map((match) => match[1]);
    expect(externalUses.length).toBeGreaterThan(0);
    for (const reference of externalUses) {
      expect(reference).toMatch(/@[a-f0-9]{40}$/);
    }
  });
});

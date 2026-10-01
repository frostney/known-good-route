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
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { parse } from "yaml";

import {
  computeCliCompatibleSkillHash,
  inspectInventory,
  parseDeletionCheckFailures,
  parseDeletedSkillWarnings,
  publishProjectSkills,
  refreshProjectSkills,
} from "./update-project-skills.mjs";

const temporaryDirectories: string[] = [];
const repositoryRoot = sourceCheckoutRoot(import.meta.url);
// Publication cases use real local clones, fetches and pushes (over 100 Git
// processes for an update). Their successful runtime approaches Bun's default
// five-second limit; keep a bounded allowance for process and filesystem load.
const publicationTimeout = 30_000;

function runGit(root: string, args: string[]) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
  return result.stdout.trim();
}

function sourceCheckoutRoot(moduleUrl: string) {
  return runGit(fileURLToPath(new URL(".", moduleUrl)), ["rev-parse", "--show-toplevel"]);
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
        computedHash: await computeCliCompatibleSkillHash(skillDirectory),
        ...overrides,
      },
    },
  };
  await writeFile(
    join(projectRoot, "skills-lock.json"),
    `${JSON.stringify(lock, null, 2)}\n`,
  );
}

async function addProjectAuthoredSkill(
  fixture: Awaited<ReturnType<typeof makeRepository>>,
  name = "house-skill",
) {
  const directory = join(fixture.projectRoot, ".agents", "skills", name);
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, "SKILL.md"),
    `---\nname: ${name}\ndescription: Project-authored fixture.\n---\n\n# House\n`,
  );
  runGit(fixture.root, ["add", "."]);
  runGit(fixture.root, ["commit", "--message", "test: add project-authored skill"]);
  return directory;
}

async function writeTamperedArtifact(
  fixture: Awaited<ReturnType<typeof makeRepository>>,
  artifactDirectory: string,
) {
  runGit(fixture.root, ["add", "-A"]);
  await writeFile(join(artifactDirectory, "skills-update.patch"),
    runGit(fixture.root, ["diff", "--cached", "--binary", "--full-index", "HEAD"]) + "\n");
  const metadataPath = join(artifactDirectory, "metadata.json");
  const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
  metadata.tree = runGit(fixture.root, ["write-tree"]);
  await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
}

async function refreshOptions(fixture: Awaited<ReturnType<typeof makeRepository>>) {
  const artifactDirectory = join(fixture.root, "..", `${fixture.skillName}-artifact-${Date.now()}`);
  temporaryDirectories.push(artifactDirectory);
  return {
    artifactDirectory,
    cliVersion: "1.5.23",
    normalizeLockHashes: false,
    repairFindSkills: false,
    repositoryRoot: fixture.root,
    skillsRoot: fixture.skillsRoot,
  };
}

async function declareEntryPoint(fixture: Awaited<ReturnType<typeof makeRepository>>) {
  await writeFile(
    join(fixture.skillDirectory, "SKILL.md"),
    `---\nname: ${fixture.skillName}\ndescription: Test fixture.\nmetadata:\n  agents-role: entry-point\n  agents-text: Run the invented example.\n---\n\n# Fixture\n`,
  );
}

async function makePublication(
  skillsRoot = ".",
  { projectAuthored = false, declareRole = false, agents = "" } = {},
) {
  const fixture = await makeRepository(skillsRoot);
  if (projectAuthored) await addProjectAuthoredSkill(fixture);
  if (agents) {
    await writeFile(join(fixture.projectRoot, "AGENTS.md"), agents);
    runGit(fixture.root, ["add", "."]);
    runGit(fixture.root, ["commit", "--message", "test: add AGENTS.md"]);
  }
  const bareRemote = await realpath(
    await mkdtemp(join(tmpdir(), "kgr-skills-remote-test-")),
  );
  temporaryDirectories.push(bareRemote);
  runGit(bareRemote, ["init", "--bare", "--initial-branch=main"]);
  runGit(fixture.root, ["remote", "add", "origin", bareRemote]);
  runGit(fixture.root, ["push", "--set-upstream", "origin", "main"]);

  const options = await refreshOptions(fixture);
  await refreshProjectSkills(options, {
    runSkills: async () => {
      await writeFile(join(fixture.skillDirectory, "reference.md"), "published\n");
      if (declareRole) await declareEntryPoint(fixture);
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
  return {
    fixture, bareRemote, fakeBin,
    options: {
      artifactDirectory: options.artifactDirectory,
      body: "Generated update.",
      branch: "automation/update-agent-skills",
      repositoryRoot: publishRoot,
      skillsRoot: fixture.skillsRoot,
      title: "chore(skills): refresh project Agent Skills",
    },
  };
}

async function withFakeGh(fixture: Awaited<ReturnType<typeof makePublication>>, run: () => Promise<void>) {
  const previousPath = process.env.PATH;
  process.env.PATH = `${fixture.fakeBin}:${previousPath}`;
  try {
    await run();
  } finally {
    process.env.PATH = previousPath;
  }
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) =>
      rm(path, { force: true, recursive: true }),
    ),
  );
});

describe("project inventory validation", () => {
  test("locates source checkout from a nested module URL with spaces and a hash", async () => {
    const parent = await realpath(await mkdtemp(join(tmpdir(), "kgr-source-root-")));
    temporaryDirectories.push(parent);
    const root = join(parent, "checkout with spaces #hash");
    const moduleDirectory = join(root, "fixtures/deeply/nested/action/source");
    await mkdir(moduleDirectory, { recursive: true });
    runGit(root, ["init", "--initial-branch=main"]);
    await writeFile(join(root, "package.json"), '{"name":"source-checkout"}\n');
    const actual = sourceCheckoutRoot(pathToFileURL(join(moduleDirectory, "update-project-skills.test.ts")).href);
    expect(actual).toBe(root);
    expect(JSON.parse(await readFile(join(actual, "package.json"), "utf8"))).toEqual({ name: "source-checkout" });
  });

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

  test("validates through the Node entrypoint and rejects invalid input without rewriting it", async () => {
    const fixture = await makeRepository();
    const runtime = join(repositoryRoot, ".github/actions/update-project-skills/update-project-skills.mjs");
    const args = [runtime, "validate", "--repository-root", fixture.root, "--skills-root", "."];
    expect(spawnSync("node", args, { encoding: "utf8" }).status).toBe(0);
    await writeInventory(fixture.projectRoot, fixture.skillName, { sourceType: "local" });
    const lockPath = join(fixture.projectRoot, "skills-lock.json");
    const before = await readFile(lockPath, "utf8");
    const rejected = spawnSync("node", [...args, "--normalize-lock-hashes", "true"], { encoding: "utf8" });
    expect(rejected.status).toBe(1);
    expect(rejected.stderr).toContain("sourceType local cannot be refreshed remotely");
    expect(await readFile(lockPath, "utf8")).toBe(before);
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

  test("keeps unlocked skill directories as project-authored and still requires every locked skill", async () => {
    const fixture = await makeRepository();
    await addProjectAuthoredSkill(fixture);
    const inventory = await inspectInventory(fixture.projectRoot);
    expect(inventory.names).toEqual(["example-skill"]);
    expect(inventory.projectAuthored).toEqual(["house-skill"]);

    await rm(fixture.skillDirectory, { recursive: true });
    await expect(inspectInventory(fixture.projectRoot)).rejects.toThrow(
      "missing locked skills: example-skill",
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

  test("preserves the pinned CLI's content hash format", async () => {
    const fixture = await makeRepository();
    await inspectInventory(fixture.projectRoot);
    expect(await computeCliCompatibleSkillHash(fixture.skillDirectory)).toBe(
      "e929f5cbe2e15d81c031b6ed74e51e8cf56a0377b6099640045012bdc2c4ea02",
    );
    expect(await computeCliCompatibleSkillHash(fixture.skillDirectory)).toBe(
      JSON.parse(
        await readFile(join(fixture.projectRoot, "skills-lock.json"), "utf8"),
      ).skills[fixture.skillName].computedHash,
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
    expect(metadata.version).toBe(1);
    expect(metadata.changed).toBe(false);
    expect(metadata.tree).toBe(runGit(fixture.root, ["rev-parse", "HEAD^{tree}"]));
    expect(await readFile(join(options.artifactDirectory, "skills-update.patch"), "utf8")).toBe("");
  });

  test("captures changed and untracked generated files at a nested root", async () => {
    const fixture = await makeRepository("paddy");
    const options = await refreshOptions(fixture);
    const result = await refreshProjectSkills(options, {
      runSkills: async () => {
        await writeFile(join(fixture.skillDirectory, "reference.md"), "updated\n");
        await writeFile(join(fixture.skillDirectory, "binary ü\n.bin"), Buffer.from([0, 255, 1]));
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
    expect(runGit(fixture.root, ["diff", "--cached", "--name-only"])).toBe("");

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
    expect(await readFile(join(applyDirectory, "paddy/.agents/skills/example-skill/binary ü\n.bin"))).toEqual(Buffer.from([0, 255, 1]));
  });

  test("keeps the real CLI on the canonical inventory when no agent home exists", async () => {
    // Stands in for `npx skills@<version> update`, modelled on the CLI's
    // agent detection: Codex counts as installed when CODEX_HOME (default
    // ~/.codex) or /etc/codex exists, and with a universal agent detected
    // the refreshed skill lands in .agents/skills. With nothing detected it
    // does what the CLI does under `-y` — installs to every agent,
    // including Eve's agent/skills outside the inventory. HOME points at an
    // empty directory, as on a hosted runner.
    const fixture = await makeRepository();
    const options = await refreshOptions(fixture);
    const scratch = await realpath(
      await mkdtemp(join(tmpdir(), "kgr-skills-npx-test-")),
    );
    temporaryDirectories.push(scratch);
    const fakeBin = join(scratch, "bin");
    const emptyHome = join(scratch, "home");
    const staged = join(scratch, "staged");
    await mkdir(fakeBin);
    await mkdir(emptyHome);
    const stagedSkill = join(staged, ".agents", "skills", fixture.skillName);
    await mkdir(stagedSkill, { recursive: true });
    await writeFile(
      join(stagedSkill, "SKILL.md"),
      await readFile(join(fixture.skillDirectory, "SKILL.md"), "utf8"),
    );
    await writeFile(join(stagedSkill, "reference.md"), "refreshed\n");
    await writeInventory(staged, fixture.skillName);
    const fakeNpx = join(fakeBin, "npx");
    await writeFile(
      fakeNpx,
      [
        "#!/bin/sh",
        'if [ -d "${CODEX_HOME:-$HOME/.codex}" ] || [ -d /etc/codex ]; then',
        `  cp -R '${staged}/.agents' . && cp '${staged}/skills-lock.json' skills-lock.json`,
        "  echo 'Updated 1 skill(s)'",
        "else",
        `  mkdir -p agent/skills/${fixture.skillName}`,
        `  printf 'stray\\n' > agent/skills/${fixture.skillName}/SKILL.md`,
        "  echo 'Installing to all agents'",
        "fi",
        "",
      ].join("\n"),
    );
    await chmod(fakeNpx, 0o755);
    const previous = {
      CODEX_HOME: process.env.CODEX_HOME,
      HOME: process.env.HOME,
      PATH: process.env.PATH,
    };
    process.env.PATH = `${fakeBin}:${previous.PATH}`;
    process.env.HOME = emptyHome;
    delete process.env.CODEX_HOME;
    try {
      const result = await refreshProjectSkills(options);
      expect(result.changed).toBe(true);
      expect(result.changedPaths.sort()).toEqual([
        `.agents/skills/${fixture.skillName}/reference.md`,
        "skills-lock.json",
      ]);
    } finally {
      for (const [name, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
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

  test("fails closed when deletion discovery degrades with status zero", async () => {
    const degraded =
      "✗ Failed to check for deleted skills from vercel-labs/skills";
    const ansiDegraded =
      "\x1b[2m✗ Failed to check for deleted skills from vercel-labs/skills\x1b[0m";
    expect(parseDeletionCheckFailures(degraded)).toEqual([
      "vercel-labs/skills",
    ]);
    expect(parseDeletionCheckFailures(ansiDegraded)).toEqual([
      "vercel-labs/skills",
    ]);
    expect(
      parseDeletionCheckFailures(
        "Unable to verify deleted skills for example/skills.",
      ),
    ).toEqual(["example/skills"]);
    expect(
      parseDeletionCheckFailures(
        "Could not check for deleted skills from example/other",
      ),
    ).toEqual(["example/other"]);

    const fixture = await makeRepository();
    await expect(
      refreshProjectSkills(await refreshOptions(fixture), {
        runSkills: () => ({ output: degraded, status: 0 }),
      }),
    ).rejects.toThrow("could not verify upstream deletions");
  });

  test("rejects same-name source identity redirects", async () => {
    const mutations = [
      { source: "example/redirected" },
      { sourceType: "git" },
      { skillPath: "moved/example-skill/SKILL.md" },
    ];

    for (const mutation of mutations) {
      const fixture = await makeRepository();
      const lockPath = join(fixture.projectRoot, "skills-lock.json");
      await expect(
        refreshProjectSkills(await refreshOptions(fixture), {
          runSkills: async () => {
            const lock = JSON.parse(await readFile(lockPath, "utf8"));
            Object.assign(lock.skills[fixture.skillName], mutation);
            await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
            return { output: "Updated 1 skill", status: 0 };
          },
        }),
      ).rejects.toThrow("changed source identity");
    }
  });

  test("refreshes locked skills around a project-authored skill it never changes", async () => {
    const fixture = await makeRepository();
    await addProjectAuthoredSkill(fixture);
    const result = await refreshProjectSkills(await refreshOptions(fixture), {
      runSkills: async () => {
        await writeFile(join(fixture.skillDirectory, "reference.md"), "refreshed\n");
        await writeInventory(fixture.projectRoot, fixture.skillName);
        return { status: 0, output: "Updated 1 skill" };
      },
    });
    expect(result.changedPaths).toEqual([
      ".agents/skills/example-skill/reference.md",
      "skills-lock.json",
    ]);

    const edited = await makeRepository();
    const house = await addProjectAuthoredSkill(edited);
    await expect(
      refreshProjectSkills(await refreshOptions(edited), {
        runSkills: async () => {
          await writeFile(join(house, "SKILL.md"), "overwritten\n");
          return { status: 0, output: "Updated 1 skill" };
        },
      }),
    ).rejects.toThrow("changed project-authored skills: .agents/skills/house-skill/SKILL.md");

    const added = await makeRepository();
    await expect(
      refreshProjectSkills(await refreshOptions(added), {
        runSkills: async () => {
          const stray = join(added.projectRoot, ".agents", "skills", "stray-skill");
          await mkdir(stray, { recursive: true });
          await writeFile(join(stray, "SKILL.md"), "stray\n");
          return { status: 0, output: "Updated 1 skill" };
        },
      }),
    ).rejects.toThrow("changed the project skill inventory");
  });

  test("publishes beside a project-authored skill and rejects an artifact that edits it", async () => {
    const publication = await makePublication(".", { projectAuthored: true });
    const { options, bareRemote } = publication;
    await withFakeGh(publication, async () => {
      const result = await publishProjectSkills(options);
      expect(result.pullRequestUrl).toBe("https://example.test/pull/1");
      expect(runGit(bareRemote, ["diff", "--name-only", "main", options.branch])).not.toContain("house-skill");
    });

    const tamperings: [string, (projectRoot: string) => Promise<void>, string][] = [
      [".", async (projectRoot) => {
        await writeFile(join(projectRoot, ".agents/skills/house-skill/SKILL.md"), "tampered\n");
      }, "changed project-authored skills"],
      ["paddy", async (projectRoot) => {
        await writeFile(join(projectRoot, ".agents/skills/house-skill/SKILL.md"), "tampered\n");
      }, "changed project-authored skills: paddy/.agents/skills/house-skill/SKILL.md"],
      [".", async (projectRoot) => {
        const stray = join(projectRoot, ".agents/skills/stray-skill");
        await mkdir(stray, { recursive: true });
        await writeFile(join(stray, "SKILL.md"), "stray\n");
      }, "changed the project-authored skill inventory"],
      [".", async (projectRoot) => {
        const house = join(projectRoot, ".agents/skills/house-skill");
        const lockPath = join(projectRoot, "skills-lock.json");
        const lock = JSON.parse(await readFile(lockPath, "utf8"));
        lock.skills["house-skill"] = {
          source: "example/skills",
          sourceType: "github",
          skillPath: "skills/house-skill/SKILL.md",
          computedHash: await computeCliCompatibleSkillHash(house),
        };
        await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
      }, "changed the project-authored skill inventory"],
    ];
    for (const [skillsRoot, tamper, message] of tamperings) {
      const tampered = await makePublication(skillsRoot, { projectAuthored: true });
      await tamper(tampered.fixture.projectRoot);
      await writeTamperedArtifact(tampered.fixture, tampered.options.artifactDirectory);
      await withFakeGh(tampered, async () => {
        await expect(publishProjectSkills(tampered.options)).rejects.toThrow(message);
        expect(runGit(tampered.bareRemote, ["branch", "--list", tampered.options.branch])).toBe("");
      });
    }
  }, publicationTimeout);

  test("keeps main's project-authored edits off an existing branch and rejects the branch editing them", async () => {
    const publication = await makePublication(".", { projectAuthored: true });
    const { options, fixture, bareRemote } = publication;
    const cycle = async (update: string) => {
      runGit(fixture.root, ["restore", "."]);
      runGit(fixture.root, ["clean", "-fd"]);
      runGit(fixture.root, ["pull", "--ff-only", "origin", "main"]);
      await refreshProjectSkills({ ...(await refreshOptions(fixture)), artifactDirectory: options.artifactDirectory }, {
        runSkills: async () => {
          await writeFile(join(fixture.skillDirectory, "reference.md"), update);
          await writeInventory(fixture.projectRoot, fixture.skillName);
          return { status: 0, output: "Updated 1 skill" };
        },
      });
      runGit(options.repositoryRoot, ["switch", "--detach", "main"]);
      runGit(options.repositoryRoot, ["branch", "-D", options.branch]);
      runGit(options.repositoryRoot, ["fetch", "origin", "main"]);
      runGit(options.repositoryRoot, ["switch", "--detach", "origin/main"]);
      return publishProjectSkills(options);
    };
    await withFakeGh(publication, async () => {
      await publishProjectSkills(options);
      const house = join(options.repositoryRoot, ".agents/skills/house-skill/SKILL.md");
      runGit(options.repositoryRoot, ["switch", "--detach", "main"]);
      await writeFile(house, "edited on main\n");
      runGit(options.repositoryRoot, ["commit", "-am", "test: edit project-authored skill on main"]);
      runGit(options.repositoryRoot, ["push", "origin", "HEAD:main"]);
      await cycle("second\n");
      await cycle("third\n");
      expect(runGit(bareRemote, ["diff", "--name-only", `main...${options.branch}`])).not.toContain("house-skill");

      runGit(options.repositoryRoot, ["switch", options.branch]);
      await writeFile(house, "edited on the automation branch\n");
      runGit(options.repositoryRoot, ["commit", "-am", "test: edit project-authored skill on the branch"]);
      runGit(options.repositoryRoot, ["push", "origin", options.branch]);
      const original = runGit(bareRemote, ["rev-parse", options.branch]);
      await expect(cycle("fourth\n")).rejects.toThrow("Existing PR branch contains files outside");
      expect(runGit(bareRemote, ["rev-parse", options.branch])).toBe(original);
    });
  }, publicationTimeout);

  test("publishes a new draft branch and reuses an unchanged existing branch", async () => {
    const publication = await makePublication();
    const { options, bareRemote } = publication;
    await withFakeGh(publication, async () => {
      const first = await publishProjectSkills(options);
      expect(first.pullRequestUrl).toBe("https://example.test/pull/1");
      expect(runGit(bareRemote, ["rev-parse", `refs/heads/${options.branch}^`])).toBe(
        runGit(bareRemote, ["rev-parse", "refs/heads/main"]),
      );
      runGit(options.repositoryRoot, ["switch", "--detach", "main"]);
      runGit(options.repositoryRoot, ["branch", "-D", options.branch]);
      const second = await publishProjectSkills(options);
      expect(second.headSha).toBe(first.headSha);
    });
  }, publicationTimeout);

  test("publishes nested inventories and rejects a different configured root", async () => {
    const publication = await makePublication("paddy");
    await withFakeGh(publication, async () => {
      await expect(publishProjectSkills({ ...publication.options, skillsRoot: "." })).rejects.toThrow("metadata is invalid");
      const result = await publishProjectSkills(publication.options);
      expect(result.pullRequestUrl).toBe("https://example.test/pull/1");
      expect(await readFile(join(publication.options.repositoryRoot, "paddy/.agents/skills/example-skill/reference.md"), "utf8")).toBe("published\n");
    });
  }, publicationTimeout);

  test("updates an existing branch by a descendant commit and removes stale generated files", async () => {
    const publication = await makePublication();
    const { options, fixture, bareRemote } = publication;
    await withFakeGh(publication, async () => {
      const first = await publishProjectSkills(options);
      runGit(fixture.root, ["restore", "."]);
      await rm(join(fixture.skillDirectory, "reference.md"));
      await refreshProjectSkills({ ...(await refreshOptions(fixture)), artifactDirectory: options.artifactDirectory }, {
        runSkills: async () => {
          await writeFile(join(fixture.skillDirectory, "replacement.md"), "second update\n");
          await writeInventory(fixture.projectRoot, fixture.skillName);
          return { status: 0, output: "Updated 1 skill" };
        },
      });
      runGit(options.repositoryRoot, ["switch", "--detach", "main"]);
      runGit(options.repositoryRoot, ["branch", "-D", options.branch]);
      const second = await publishProjectSkills(options);
      expect(runGit(bareRemote, ["rev-parse", `${second.headSha}^`])).toBe(first.headSha);
      expect(runGit(bareRemote, ["ls-tree", "-r", "--name-only", second.headSha])).not.toContain("reference.md");
      expect(await readFile(join(options.repositoryRoot, ".agents/skills/example-skill/replacement.md"), "utf8")).toBe("second update\n");
    });
  }, publicationTimeout);

  test("preserves an existing branch containing foreign changes", async () => {
    const publication = await makePublication();
    const { options, bareRemote } = publication;
    await withFakeGh(publication, async () => {
      await publishProjectSkills(options);
      await writeFile(join(options.repositoryRoot, "foreign.txt"), "manual work\n");
      runGit(options.repositoryRoot, ["add", "foreign.txt"]);
      runGit(options.repositoryRoot, ["commit", "-m", "test: manual work"]);
      runGit(options.repositoryRoot, ["push", "origin", options.branch]);
      const original = runGit(bareRemote, ["rev-parse", options.branch]);
      runGit(options.repositoryRoot, ["switch", "--detach", "main"]);
      runGit(options.repositoryRoot, ["branch", "-D", options.branch]);
      await expect(publishProjectSkills(options)).rejects.toThrow("Existing PR branch contains files outside");
      expect(runGit(bareRemote, ["rev-parse", options.branch])).toBe(original);
    });
  }, publicationTimeout);

  test("regenerates the AGENTS.md skills block in the refresh and publishes it", async () => {
    const publication = await makePublication("paddy", { declareRole: true, agents: "# House rules\n" });
    const { options, bareRemote } = publication;
    const patch = await readFile(join(options.artifactDirectory, "skills-update.patch"), "utf8");
    expect(patch).toContain("paddy/AGENTS.md");
    await withFakeGh(publication, async () => {
      await publishProjectSkills(options);
      const published = runGit(bareRemote, ["show", `${options.branch}:paddy/AGENTS.md`]);
      expect(published.startsWith("# House rules\n\n<!-- known-good-route:agents:begin -->")).toBe(true);
      expect(published).toContain("- Start with `/example-skill`: Run the invented example.");
    });
  }, publicationTimeout);

  test("rejects an artifact that edits AGENTS.md outside the generated block", async () => {
    const publication = await makePublication(".", { declareRole: true, agents: "# House rules\n" });
    const { options, fixture, bareRemote } = publication;
    const agentsPath = join(fixture.projectRoot, "AGENTS.md");
    await writeFile(agentsPath, (await readFile(agentsPath, "utf8")).replace("# House rules", "# Rewritten rules"));
    await writeTamperedArtifact(fixture, options.artifactDirectory);
    await withFakeGh(publication, async () => {
      await expect(publishProjectSkills(options)).rejects.toThrow("changed AGENTS.md beyond the generated skills block");
      expect(runGit(bareRemote, ["branch", "--list", options.branch])).toBe("");
    });
  }, publicationTimeout);

  test("keeps main's hand-written AGENTS.md edits off an existing branch", async () => {
    const publication = await makePublication(".", { declareRole: true, agents: "# House rules\n" });
    const { options, fixture, bareRemote } = publication;
    await withFakeGh(publication, async () => {
      await publishProjectSkills(options);
      runGit(options.repositoryRoot, ["switch", "--detach", "main"]);
      await writeFile(join(options.repositoryRoot, "AGENTS.md"), "# House rules\n\nEdited on main.\n");
      runGit(options.repositoryRoot, ["commit", "-am", "test: edit AGENTS.md on main"]);
      runGit(options.repositoryRoot, ["push", "origin", "HEAD:main"]);

      runGit(fixture.root, ["restore", "."]);
      runGit(fixture.root, ["clean", "-fd"]);
      runGit(fixture.root, ["pull", "--ff-only", "origin", "main"]);
      await refreshProjectSkills({ ...(await refreshOptions(fixture)), artifactDirectory: options.artifactDirectory }, {
        runSkills: async () => {
          await writeFile(join(fixture.skillDirectory, "reference.md"), "second\n");
          await declareEntryPoint(fixture);
          await writeInventory(fixture.projectRoot, fixture.skillName);
          return { status: 0, output: "Updated 1 skill" };
        },
      });
      runGit(options.repositoryRoot, ["branch", "-D", options.branch]);
      runGit(options.repositoryRoot, ["fetch", "origin", "main"]);
      runGit(options.repositoryRoot, ["switch", "--detach", "origin/main"]);
      await publishProjectSkills(options);

      const branchAgents = runGit(bareRemote, ["show", `${options.branch}:AGENTS.md`]);
      expect(branchAgents).not.toContain("Edited on main.");
      expect(branchAgents).toContain("- Start with `/example-skill`: Run the invented example.");
      expect(runGit(bareRemote, ["show", `${options.branch}:.agents/skills/example-skill/reference.md`])).toBe("second");
    });
  }, publicationTimeout);

  test("rejects a patch with unrelated files before publishing", async () => {
    const publication = await makePublication();
    const { options, fixture, bareRemote } = publication;
    await writeFile(join(fixture.root, "unrelated.txt"), "unexpected\n");
    runGit(fixture.root, ["add", "-A"]);
    await writeFile(join(options.artifactDirectory, "skills-update.patch"),
      runGit(fixture.root, ["diff", "--cached", "--binary", "--full-index", "HEAD"]) + "\n");
    await withFakeGh(publication, async () => {
      await expect(publishProjectSkills(options)).rejects.toThrow("outside its generated scope");
      expect(runGit(bareRemote, ["branch", "--list", options.branch])).toBe("");
    });
  });

  test("rejects file-mode changes absent from the refresh snapshot", async () => {
    const publication = await makePublication();
    const { options, fixture, bareRemote } = publication;
    runGit(fixture.root, ["add", "-A"]);
    runGit(fixture.root, ["update-index", "--chmod=+x", ".agents/skills/example-skill/SKILL.md"]);
    await writeFile(join(options.artifactDirectory, "skills-update.patch"),
      runGit(fixture.root, ["diff", "--cached", "--binary", "--full-index", "HEAD"]) + "\n");
    await withFakeGh(publication, async () => {
      await expect(publishProjectSkills(options)).rejects.toThrow("does not match the snapshot");
      expect(runGit(bareRemote, ["branch", "--list", options.branch])).toBe("");
    });
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
      "1.5.23",
    );
    expect(
      workflow.on.workflow_call.inputs["normalize-lock-hashes"].default,
    ).toBe(false);
    expect(workflow.jobs.refresh.permissions).toEqual({ contents: "read" });
    expect(workflow.jobs.publish.permissions).toEqual({
      actions: "read",
      contents: "write",
      "pull-requests": "write",
    });
    expect(raw).not.toContain("actions: write");
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

  test("exposes a read-only AGENTS.md skills block check through the same helper", async () => {
    const raw = await readFile(join(repositoryRoot, ".github/workflows/verify-agents-block.yml"), "utf8");
    const workflow = parse(raw);
    expect(workflow.on.workflow_call.inputs["skills-root"].default).toBe(".");
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(workflow.jobs.verify.permissions).toEqual({ contents: "read" });
    const helper = workflow.jobs.verify.steps.find(
      (step: { uses?: string }) => step.uses === "$/.github/actions/update-project-skills",
    );
    expect(helper.with.mode).toBe("verify-agents-block");
    const actionlintConfig = parse(await readFile(join(repositoryRoot, ".github/actionlint.yaml"), "utf8"));
    expect(actionlintConfig.paths[".github/workflows/verify-agents-block.yml"].ignore).toEqual([
      'specifying action "\\$/\\.github/actions/update-project-skills" in invalid format because ref is missing',
    ]);
  });

  test("keeps every third-party workflow action pinned to a full SHA", async () => {
    for (const file of ["update-project-skills.yml", "verify-agents-block.yml"]) {
      const raw = await readFile(join(repositoryRoot, ".github/workflows", file), "utf8");
      const externalUses = [
        ...raw.matchAll(
          /^\s*uses:\s+([A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+@[a-f0-9]+)\s*(?:#.*)?$/gm,
        ),
      ].map((match) => match[1]);
      expect(externalUses.length).toBeGreaterThan(0);
      for (const reference of externalUses) {
        expect(reference).toMatch(/@[a-f0-9]{40}$/);
      }
    }
  });
});

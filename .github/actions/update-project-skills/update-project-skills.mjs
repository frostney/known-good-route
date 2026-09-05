#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";

const LOCK_FILE = "skills-lock.json";
const SKILLS_DIRECTORY = ".agents/skills";
const FIND_SKILLS_SOURCE = "vercel-labs/skills";
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const CLI_VERSION_PATTERN = /^\d+\.\d+\.\d+$/;
const REMOTE_SOURCE_TYPES = new Set(["git", "github", "gitlab", "well-known"]);

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: options.encoding === undefined ? "utf8" : options.encoding,
    env: options.env ?? process.env,
    maxBuffer: 64 * 1024 * 1024,
    stdio: options.stdio ?? "pipe",
  });
  if (result.error) {
    throw new Error(
      `Could not run ${command}: ${result.error.message}`,
    );
  }
  if (result.status !== 0 && !options.allowFailure) {
    const detail = [result.stdout, result.stderr]
      .filter(Boolean)
      .join("\n")
      .trim();
    throw new Error(
      `${command} ${args.join(" ")} failed with status ${result.status}${detail ? `:\n${detail}` : ""}`,
    );
  }
  return result;
}

function git(repositoryRoot, args, options = {}) {
  return run("git", args, { ...options, cwd: repositoryRoot });
}

function toGitPath(path) {
  return path.split(sep).join("/");
}

function isPathInside(path, parent) {
  const child = relative(parent, path);
  return child === "" || (!child.startsWith(`..${sep}`) && child !== "..");
}

async function requireCanonicalDirectory(path, label) {
  let metadata;
  try {
    metadata = await lstat(path);
  } catch {
    throw new Error(`${label} is missing: ${path}`);
  }
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`${label} must be a real directory: ${path}`);
  }
  if ((await realpath(path)) !== path) {
    throw new Error(`${label} is not a canonical path: ${path}`);
  }
}

async function collectSkillFiles(baseDirectory, currentDirectory, files) {
  const entries = await readdir(currentDirectory, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    if (entry.name === ".git" || entry.name === "node_modules") continue;
    const path = join(currentDirectory, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`Skill payload contains a symlink: ${path}`);
    }
    if (entry.isDirectory()) {
      await collectSkillFiles(baseDirectory, path, files);
      continue;
    }
    if (!entry.isFile()) {
      throw new Error(`Skill payload contains a non-file entry: ${path}`);
    }
    files.push({
      path,
      relativePath: toGitPath(relative(baseDirectory, path)),
    });
  }
}

export async function computeCliCompatibleSkillHash(skillDirectory) {
  const root = resolve(skillDirectory);
  await requireCanonicalDirectory(root, "Skill directory");
  const files = [];
  await collectSkillFiles(root, root, files);
  files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  const hash = createHash("sha256");
  // Match the pinned CLI's computedHash; artifact integrity uses Git's tree ID.
  for (const file of files) {
    hash.update(file.relativePath);
    hash.update(await readFile(file.path));
  }
  return hash.digest("hex");
}

async function loadLock(root) {
  const lockPath = join(root, LOCK_FILE);
  let raw;
  try {
    raw = await readFile(lockPath, "utf8");
  } catch {
    throw new Error(`Project inventory is missing: ${lockPath}`);
  }
  let lock;
  try {
    lock = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `Project inventory is not valid JSON: ${error.message}`,
    );
  }
  if (
    !lock ||
    lock.version !== 1 ||
    !lock.skills ||
    typeof lock.skills !== "object" ||
    Array.isArray(lock.skills)
  ) {
    throw new Error(
      "Project inventory must be a version 1 skills-lock.json object",
    );
  }
  return { lock, lockPath, raw };
}

function validateLockEntry(name, entry, normalizeHashes) {
  if (!SKILL_NAME_PATTERN.test(name)) {
    throw new Error(`Inventory contains a non-canonical skill name: ${name}`);
  }
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    throw new Error(`Inventory entry ${name} must be an object`);
  }
  if (typeof entry.source !== "string" || entry.source.length === 0) {
    throw new Error(`Inventory entry ${name} is missing source`);
  }
  if (!REMOTE_SOURCE_TYPES.has(entry.sourceType)) {
    throw new Error(
      `Inventory entry ${name} is blocked: sourceType ${String(entry.sourceType)} cannot be refreshed remotely`,
    );
  }
  if (
    typeof entry.skillPath !== "string" ||
    entry.skillPath.length === 0 ||
    entry.skillPath.startsWith("/") ||
    entry.skillPath.split("/").includes("..") ||
    !entry.skillPath.endsWith("SKILL.md")
  ) {
    throw new Error(
      `Inventory entry ${name} is blocked: skillPath is missing or unsafe`,
    );
  }
  if (!normalizeHashes &&
      (typeof entry.computedHash !== "string" || !HASH_PATTERN.test(entry.computedHash))) {
    throw new Error(
      `Inventory entry ${name} has a missing or invalid computedHash`,
    );
  }
}

export async function inspectInventory(skillsRoot, { normalizeHashes = false } = {}) {
  const root = resolve(skillsRoot);
  await requireCanonicalDirectory(root, "Skills root");
  const canonicalDirectory = join(root, SKILLS_DIRECTORY);
  await requireCanonicalDirectory(canonicalDirectory, "Canonical skills inventory");
  const { lock, lockPath, raw } = await loadLock(root);
  const names = Object.keys(lock.skills);
  if (names.length === 0) {
    throw new Error("Project inventory contains no skills");
  }
  const sortedNames = [...names].sort((left, right) => left.localeCompare(right));
  if (!normalizeHashes && names.some((name, index) => name !== sortedNames[index])) {
    throw new Error("Project inventory keys are not in canonical order");
  }

  const diskEntries = await readdir(canonicalDirectory, { withFileTypes: true });
  const diskNames = diskEntries.map((entry) => entry.name).sort();
  if (
    diskEntries.some(
      (entry) => !entry.isDirectory() || entry.isSymbolicLink(),
    )
  ) {
    throw new Error(
      `Canonical skills inventory contains a non-directory entry: ${canonicalDirectory}`,
    );
  }
  if (JSON.stringify(diskNames) !== JSON.stringify(sortedNames)) {
    const missing = sortedNames.filter((name) => !diskNames.includes(name));
    const untracked = diskNames.filter((name) => !sortedNames.includes(name));
    throw new Error(
      `Canonical skills inventory does not match skills-lock.json (missing: ${missing.join(", ") || "none"}; untracked: ${untracked.join(", ") || "none"})`,
    );
  }

  const identities = {};
  for (const name of sortedNames) {
    const entry = lock.skills[name];
    validateLockEntry(name, entry, normalizeHashes);
    const directory = join(canonicalDirectory, name);
    await requireCanonicalDirectory(directory, `Canonical skill ${name}`);
    const skillEntrypoint = join(directory, "SKILL.md");
    let entrypointMetadata;
    try {
      entrypointMetadata = await stat(skillEntrypoint);
    } catch {
      throw new Error(`Canonical skill ${name} is missing SKILL.md`);
    }
    if (!entrypointMetadata.isFile()) {
      throw new Error(`Canonical skill ${name} has an invalid SKILL.md`);
    }
    const cliCompatibleHash = await computeCliCompatibleSkillHash(directory);
    identities[name] = Object.fromEntries(
      Object.entries(entry)
        .filter(([key]) => key !== "computedHash")
        .sort(([left], [right]) => left.localeCompare(right)),
    );
    if (normalizeHashes) entry.computedHash = cliCompatibleHash;
    if (entry.computedHash !== cliCompatibleHash) {
      throw new Error(
        `Canonical content hash mismatch for ${name}: lock=${entry.computedHash} disk=${cliCompatibleHash}`,
      );
    }
  }

  if (normalizeHashes) {
    lock.skills = Object.fromEntries(sortedNames.map((name) => [name, lock.skills[name]]));
    const normalized = `${JSON.stringify(lock, null, 2)}\n`;
    if (normalized !== raw) await writeFile(lockPath, normalized, "utf8");
  }
  return { identities, names: sortedNames };
}

function parseChangedPaths(repositoryRoot) {
  const tracked = git(repositoryRoot, ["diff", "--name-only", "-z", "HEAD", "--"]).stdout
    .split("\0")
    .filter(Boolean);
  const untracked = git(repositoryRoot, [
    "ls-files",
    "-z",
    "--others",
    "--exclude-standard",
    "--",
  ]).stdout
    .split("\0")
    .filter(Boolean);
  return [...new Set([...tracked, ...untracked])].sort();
}

function isScopedPath(path, scopedPaths) {
  return scopedPaths.some((scope) => path === scope || path.startsWith(`${scope}/`));
}

function requireCleanRepository(repositoryRoot) {
  const changedPaths = parseChangedPaths(repositoryRoot);
  if (changedPaths.length > 0) {
    throw new Error(
      `Caller checkout must be clean before refresh: ${changedPaths.join(", ")}`,
    );
  }
}

function stripAnsi(value) {
  return value.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
}

export function parseDeletedSkillWarnings(output) {
  const names = new Set();
  let inWarning = false;
  for (const line of stripAnsi(output).split("\n")) {
    if (line.includes("appear to have been deleted upstream")) {
      inWarning = true;
      continue;
    }
    if (!inWarning) continue;
    const match = line.match(/^\s*[•*-]\s+([a-z0-9][a-z0-9-]*)\s*$/i);
    if (match) {
      names.add(match[1]);
      continue;
    }
    if (line.includes("Skipping deletion") || (line.trim() && !/^\s/.test(line))) {
      inWarning = false;
    }
  }
  return [...names].sort();
}

export function parseDeletionCheckFailures(output) {
  const sources = new Set();
  for (const line of stripAnsi(output).split(/\r?\n/)) {
    const match = line.match(
      /(?:(?:failed|unable)\s+to|could\s+not)\s+(?:check\s+for|verify)\s+deleted\s+skills\s+(?:from|for)\s+(.+?)\s*$/i,
    );
    if (!match) continue;
    const source = match[1].replace(/[.!]+$/, "").trim();
    if (source) sources.add(source);
  }
  return [...sources].sort();
}

function defaultSkillsRunner(args, cwd, cliVersion) {
  const result = run(
    "npx",
    ["--yes", `skills@${cliVersion}`, ...args],
    {
      cwd,
      env: {
        ...process.env,
        DISABLE_TELEMETRY: "1",
        DO_NOT_TRACK: "1",
      },
      allowFailure: true,
    },
  );
  const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
  process.stdout.write(output);
  return { status: result.status ?? 1, output };
}

async function createPatch(repositoryRoot, scopedPaths, artifactDirectory, metadata) {
  await mkdir(artifactDirectory, { recursive: true });
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "kgr-skills-index-"));
  const temporaryIndex = join(temporaryDirectory, "index");
  try {
    const environment = { ...process.env, GIT_INDEX_FILE: temporaryIndex };
    git(repositoryRoot, ["read-tree", "HEAD"], { env: environment });
    git(repositoryRoot, ["add", "-A", "--", ...scopedPaths], {
      env: environment,
    });
    const patch = git(
      repositoryRoot,
      ["diff", "--cached", "--binary", "--full-index", "HEAD", "--"],
      { encoding: null, env: environment },
    ).stdout;
    await writeFile(join(artifactDirectory, "skills-update.patch"), patch);
    const tree = git(repositoryRoot, ["write-tree"], { env: environment }).stdout.trim();
    await writeFile(
      join(artifactDirectory, "metadata.json"),
      `${JSON.stringify({ ...metadata, tree }, null, 2)}\n`,
      "utf8",
    );
  } finally {
    await rm(temporaryDirectory, { force: true, recursive: true });
  }
}

function resolveSkillsRoot(repositoryRoot, skillsRootInput) {
  if (
    !skillsRootInput ||
    isAbsolute(skillsRootInput) ||
    (skillsRootInput !== "." &&
      skillsRootInput.split(/[\\/]/).some((part) => !part || part === "." || part === ".."))
  ) {
    throw new Error("skills-root must be a relative project path");
  }
  const skillsRoot = resolve(repositoryRoot, skillsRootInput);
  if (!isPathInside(skillsRoot, repositoryRoot)) {
    throw new Error("skills-root must stay inside the caller repository");
  }
  return skillsRoot;
}

function scopedPathsFor(repositoryRoot, skillsRoot) {
  const prefix = toGitPath(relative(repositoryRoot, skillsRoot));
  return [
    prefix ? `${prefix}/${SKILLS_DIRECTORY}` : SKILLS_DIRECTORY,
    prefix ? `${prefix}/${LOCK_FILE}` : LOCK_FILE,
  ];
}

export async function refreshProjectSkills(options, dependencies = {}) {
  const repositoryRoot = resolve(options.repositoryRoot);
  await requireCanonicalDirectory(repositoryRoot, "Repository root");
  const actualRepositoryRoot = resolve(
    git(repositoryRoot, ["rev-parse", "--show-toplevel"]).stdout.trim(),
  );
  if (actualRepositoryRoot !== repositoryRoot) {
    throw new Error(
      `Repository root must be the Git top level: ${repositoryRoot}`,
    );
  }
  if (!CLI_VERSION_PATTERN.test(options.cliVersion)) {
    throw new Error(
      `skills-cli-version must be an exact semver, received ${options.cliVersion}`,
    );
  }
  requireCleanRepository(repositoryRoot);
  const skillsRoot = resolveSkillsRoot(repositoryRoot, options.skillsRoot);
  const before = await inspectInventory(skillsRoot, {
    normalizeHashes: options.normalizeLockHashes,
  });
  const scopedPaths = scopedPathsFor(repositoryRoot, skillsRoot);
  const runSkills =
    dependencies.runSkills ??
    ((args, cwd) => defaultSkillsRunner(args, cwd, options.cliVersion));
  const update = await runSkills(
    ["update", "--project", "--yes"],
    skillsRoot,
    options.cliVersion,
  );
  if (update.status !== 0) {
    throw new Error(
      `Project Agent Skills update failed with status ${update.status}`,
    );
  }
  const deletionCheckFailures = parseDeletionCheckFailures(
    update.output ?? "",
  );
  if (deletionCheckFailures.length > 0) {
    throw new Error(
      `Project Agent Skills update could not verify upstream deletions for: ${deletionCheckFailures.join(", ")}`,
    );
  }
  const deletedSkills = parseDeletedSkillWarnings(update.output ?? "");
  if (deletedSkills.length > 0) {
    const repairable =
      options.repairFindSkills &&
      deletedSkills.length === 1 &&
      deletedSkills[0] === "find-skills" &&
      before.names.includes("find-skills");
    if (!repairable) {
      throw new Error(
        `Project inventory is blocked by deleted or renamed upstream skills: ${deletedSkills.join(", ")}`,
      );
    }
    const repair = await runSkills(
      [
        "add",
        FIND_SKILLS_SOURCE,
        "--skill",
        "find-skills",
        "--full-depth",
        "--yes",
      ],
      skillsRoot,
      options.cliVersion,
    );
    if (repair.status !== 0) {
      throw new Error(
        `find-skills full-depth repair failed with status ${repair.status}`,
      );
    }
  }
  const after = await inspectInventory(skillsRoot, {
    normalizeHashes: options.normalizeLockHashes,
  });
  if (JSON.stringify(before.names) !== JSON.stringify(after.names)) {
    throw new Error(
      "Automated refresh changed the project skill inventory; migrate additions, deletions, or renames manually from source evidence",
    );
  }
  const changedIdentities = before.names.filter(
    (name) =>
      JSON.stringify(before.identities[name]) !==
      JSON.stringify(after.identities[name]),
  );
  if (changedIdentities.length > 0) {
    throw new Error(
      `Automated refresh changed source identity for existing skills: ${changedIdentities.join(", ")}`,
    );
  }

  const changedPaths = parseChangedPaths(repositoryRoot);
  const outsideScope = changedPaths.filter(
    (path) => !isScopedPath(path, scopedPaths),
  );
  if (outsideScope.length > 0) {
    throw new Error(
      `Skills refresh changed files outside its generated scope: ${outsideScope.join(", ")}`,
    );
  }
  const changed = changedPaths.length > 0;
  const baseSha = git(repositoryRoot, ["rev-parse", "HEAD"]).stdout.trim();
  await createPatch(repositoryRoot, scopedPaths, resolve(options.artifactDirectory), {
    version: 1,
    baseSha,
    changed,
    skillsRoot: toGitPath(relative(repositoryRoot, skillsRoot)) || ".",
  });
  return { baseSha, changed, changedPaths, scopedPaths };
}

function parseJsonOutput(value, label) {
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new Error(`${label} returned invalid JSON: ${error.message}`);
  }
}

export async function publishProjectSkills(options) {
  const repositoryRoot = resolve(options.repositoryRoot);
  await requireCanonicalDirectory(repositoryRoot, "Repository root");
  requireCleanRepository(repositoryRoot);
  git(repositoryRoot, ["check-ref-format", "--branch", options.branch]);
  if (!options.title.trim() || !options.body.trim()) {
    throw new Error("PR title and body must not be empty");
  }
  const artifactDirectory = resolve(options.artifactDirectory);
  const metadata = parseJsonOutput(
    await readFile(join(artifactDirectory, "metadata.json"), "utf8"),
    "Artifact metadata",
  );
  if (
    metadata?.version !== 1 || metadata.changed !== true ||
    !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(metadata.baseSha) ||
    !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(metadata.tree) ||
    metadata.skillsRoot !== (options.skillsRoot ?? ".")
  ) {
    throw new Error("Skills update artifact metadata is invalid");
  }
  const skillsRoot = resolveSkillsRoot(repositoryRoot, options.skillsRoot ?? ".");
  const scopedPaths = scopedPathsFor(repositoryRoot, skillsRoot);
  const currentSha = git(repositoryRoot, ["rev-parse", "HEAD"]).stdout.trim();
  if (currentSha !== metadata.baseSha) {
    throw new Error(
      `Publish checkout does not match refresh base: expected ${metadata.baseSha}, received ${currentSha}`,
    );
  }
  git(repositoryRoot, [
    "apply", "--index", "--binary", join(artifactDirectory, "skills-update.patch"),
  ]);
  const outsideScope = parseChangedPaths(repositoryRoot).filter(
    (path) => !isScopedPath(path, scopedPaths),
  );
  if (outsideScope.length > 0) {
    throw new Error(`Artifact changed files outside its generated scope: ${outsideScope.join(", ")}`);
  }
  if (git(repositoryRoot, ["write-tree"]).stdout.trim() !== metadata.tree) {
    throw new Error("Published tree does not match the snapshot produced by refresh");
  }
  await inspectInventory(skillsRoot);
  // The verified tree is now a local Git object. Restore the base before switching branches.
  git(repositoryRoot, [
    "restore", "--source=HEAD", "--staged", "--worktree", "--", ...scopedPaths,
  ]);
  const remoteBranchRef = `refs/remotes/origin/${options.branch}`;
  const branchExists =
    git(
      repositoryRoot,
      ["ls-remote", "--exit-code", "--heads", "origin", `refs/heads/${options.branch}`],
      { allowFailure: true },
    ).status === 0;
  if (branchExists) {
    git(repositoryRoot, [
      "fetch",
      "--no-tags",
      "origin",
      `refs/heads/${options.branch}:${remoteBranchRef}`,
    ]);
    const ownedPaths = git(repositoryRoot, [
      "diff",
      "--name-only", "-z",
      `${metadata.baseSha}...${remoteBranchRef}`,
      "--",
    ]).stdout
      .split("\0")
      .filter(Boolean);
    const foreignPaths = ownedPaths.filter(
      (path) => !isScopedPath(path, scopedPaths),
    );
    if (foreignPaths.length > 0) {
      throw new Error(
        `Existing PR branch contains files outside the generated scope: ${foreignPaths.join(", ")}`,
      );
    }
    git(repositoryRoot, ["switch", "--create", options.branch, "--track", remoteBranchRef]);
  } else {
    git(repositoryRoot, ["switch", "--create", options.branch, metadata.baseSha]);
  }
  git(repositoryRoot, [
    "restore", `--source=${metadata.tree}`, "--staged", "--worktree", "--", ...scopedPaths,
  ]);

  const hasCommit =
    git(repositoryRoot, ["diff", "--cached", "--quiet", "--"], {
      allowFailure: true,
    }).status !== 0;
  if (hasCommit) {
    git(repositoryRoot, ["config", "user.name", "github-actions[bot]"]);
    git(repositoryRoot, [
      "config",
      "user.email",
      "41898282+github-actions[bot]@users.noreply.github.com",
    ]);
    git(repositoryRoot, ["commit", "--message", options.title]);
    const pushArguments = branchExists
      ? ["push", "origin", `HEAD:refs/heads/${options.branch}`]
      : ["push", "--set-upstream", "origin", options.branch];
    git(repositoryRoot, pushArguments);
  }

  const existingPullRequests = parseJsonOutput(
    run(
      "gh",
      [
        "pr",
        "list",
        "--state",
        "open",
        "--head",
        options.branch,
        "--json",
        "number,url",
        "--limit",
        "2",
      ],
      { cwd: repositoryRoot },
    ).stdout,
    "gh pr list",
  );
  if (!Array.isArray(existingPullRequests) || existingPullRequests.length > 1) {
    throw new Error(
      `Expected at most one open PR for ${options.branch}`,
    );
  }
  let pullRequestUrl;
  if (existingPullRequests.length === 1) {
    pullRequestUrl = existingPullRequests[0].url;
    run(
      "gh",
      ["pr", "edit", pullRequestUrl, "--title", options.title, "--body", options.body],
      { cwd: repositoryRoot },
    );
  } else {
    pullRequestUrl = run(
      "gh",
      [
        "pr",
        "create",
        "--draft",
        "--head",
        options.branch,
        "--title",
        options.title,
        "--body",
        options.body,
      ],
      { cwd: repositoryRoot },
    ).stdout.trim();
  }
  return {
    headSha: git(repositoryRoot, ["rev-parse", "HEAD"]).stdout.trim(),
    pullRequestUrl,
  };
}

function parseArguments(argv) {
  const command = argv[0];
  const values = {};
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      throw new Error(`Unexpected argument: ${token}`);
    }
    const key = token.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for --${key}`);
    }
    values[key] = value;
    index += 1;
  }
  return { command, values };
}

function booleanInput(value, label) {
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${label} must be true or false`);
}

function appendOutput(name, value) {
  if (!process.env.GITHUB_OUTPUT) return;
  const safeValue = String(value).replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
  return writeFile(process.env.GITHUB_OUTPUT, `${name}=${safeValue}\n`, { flag: "a" });
}

export async function main(argv = process.argv.slice(2)) {
  const { command, values } = parseArguments(argv);
  const repositoryRoot = values["repository-root"] ?? process.cwd();
  if (command === "refresh") {
    const result = await refreshProjectSkills({
      artifactDirectory: values["artifact-directory"],
      cliVersion: values["cli-version"],
      normalizeLockHashes: booleanInput(
        values["normalize-lock-hashes"],
        "normalize-lock-hashes",
      ),
      repairFindSkills: booleanInput(
        values["repair-find-skills"],
        "repair-find-skills",
      ),
      repositoryRoot,
      skillsRoot: values["skills-root"],
    });
    await appendOutput("changed", result.changed);
    await appendOutput("source_sha", result.baseSha);
    return;
  }
  if (command === "publish") {
    const result = await publishProjectSkills({
      artifactDirectory: values["artifact-directory"],
      body: process.env.KGR_PR_BODY ?? "",
      branch: values.branch,
      repositoryRoot,
      skillsRoot: values["skills-root"] ?? ".",
      title: process.env.KGR_PR_TITLE ?? "",
    });
    await appendOutput("head_sha", result.headSha);
    await appendOutput("pr_url", result.pullRequestUrl);
    return;
  }
  if (command === "validate") {
    const root = resolveSkillsRoot(resolve(repositoryRoot), values["skills-root"]);
    await inspectInventory(root, {
      normalizeHashes: booleanInput(
        values["normalize-lock-hashes"] ?? "false", "normalize-lock-hashes",
      ),
    });
    return;
  }
  throw new Error(`Unknown command: ${String(command)}`);
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`project-skills-update: ${message}\n`);
    process.exitCode = 1;
  }
}

#!/usr/bin/env bun

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
const TREE_MANIFEST_DOMAIN = Buffer.from("known-good-route:skill-tree:v1\0");
const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const CLI_VERSION_PATTERN = /^\d+\.\d+\.\d+$/;
const BRANCH_PATTERN = /^(?!-)(?!.*\.\.)(?!.*\/\/)[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const REMOTE_SOURCE_TYPES = new Set(["git", "github", "gitlab", "well-known"]);

class ProjectSkillsError extends Error {
  constructor(message) {
    super(message);
    this.name = "ProjectSkillsError";
  }
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: options.encoding === undefined ? "utf8" : options.encoding,
    env: options.env ?? process.env,
    maxBuffer: 64 * 1024 * 1024,
    stdio: options.stdio ?? "pipe",
  });
  if (result.error) {
    throw new ProjectSkillsError(
      `Could not run ${command}: ${result.error.message}`,
    );
  }
  if (result.status !== 0 && !options.allowFailure) {
    const detail = [result.stdout, result.stderr]
      .filter(Boolean)
      .join("\n")
      .trim();
    throw new ProjectSkillsError(
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
    throw new ProjectSkillsError(`${label} is missing: ${path}`);
  }
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new ProjectSkillsError(`${label} must be a real directory: ${path}`);
  }
  if ((await realpath(path)) !== path) {
    throw new ProjectSkillsError(`${label} is not a canonical path: ${path}`);
  }
}

async function collectSkillFiles(baseDirectory, currentDirectory, files) {
  const entries = await readdir(currentDirectory, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    if (entry.name === ".git" || entry.name === "node_modules") continue;
    const path = join(currentDirectory, entry.name);
    if (entry.isSymbolicLink()) {
      throw new ProjectSkillsError(`Skill payload contains a symlink: ${path}`);
    }
    if (entry.isDirectory()) {
      await collectSkillFiles(baseDirectory, path, files);
      continue;
    }
    if (!entry.isFile()) {
      throw new ProjectSkillsError(`Skill payload contains a non-file entry: ${path}`);
    }
    files.push({
      path,
      relativePath: toGitPath(relative(baseDirectory, path)),
    });
  }
}

async function readSkillFileRecords(skillDirectory) {
  await requireCanonicalDirectory(resolve(skillDirectory), "Skill directory");
  const files = [];
  await collectSkillFiles(resolve(skillDirectory), resolve(skillDirectory), files);
  files.sort((left, right) =>
    left.relativePath.localeCompare(right.relativePath),
  );
  return Promise.all(
    files.map(async (file) => ({
      content: await readFile(file.path),
      relativePath: file.relativePath,
    })),
  );
}

function updateLengthPrefixedRecord(hash, type, value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8");
  const length = Buffer.alloc(8);
  length.writeBigUInt64BE(BigInt(bytes.length));
  hash.update(Buffer.from([type]));
  hash.update(length);
  hash.update(bytes);
}

async function computeSkillHashes(skillDirectory) {
  const files = await readSkillFileRecords(skillDirectory);
  const cliCompatibleHash = createHash("sha256");
  const treeManifestHash = createHash("sha256");
  treeManifestHash.update(TREE_MANIFEST_DOMAIN);
  for (const file of files) {
    // Keep the upstream CLI's path+content stream only for computedHash
    // compatibility. KGR's own manifest uses an unambiguous framed encoding.
    cliCompatibleHash.update(file.relativePath);
    cliCompatibleHash.update(file.content);
    updateLengthPrefixedRecord(treeManifestHash, 1, file.relativePath);
    updateLengthPrefixedRecord(treeManifestHash, 2, file.content);
  }
  return {
    cliCompatibleHash: cliCompatibleHash.digest("hex"),
    treeManifestHash: treeManifestHash.digest("hex"),
  };
}

export async function computeCliCompatibleSkillHash(skillDirectory) {
  return (await computeSkillHashes(skillDirectory)).cliCompatibleHash;
}

export async function computeSkillDirectoryHash(skillDirectory) {
  return (await computeSkillHashes(skillDirectory)).treeManifestHash;
}

async function loadLock(root) {
  const lockPath = join(root, LOCK_FILE);
  let raw;
  try {
    raw = await readFile(lockPath, "utf8");
  } catch {
    throw new ProjectSkillsError(`Project inventory is missing: ${lockPath}`);
  }
  let lock;
  try {
    lock = JSON.parse(raw);
  } catch (error) {
    throw new ProjectSkillsError(
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
    throw new ProjectSkillsError(
      "Project inventory must be a version 1 skills-lock.json object",
    );
  }
  return { lock, lockPath, raw };
}

function validateLockEntry(name, entry) {
  if (!SKILL_NAME_PATTERN.test(name)) {
    throw new ProjectSkillsError(`Inventory contains a non-canonical skill name: ${name}`);
  }
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    throw new ProjectSkillsError(`Inventory entry ${name} must be an object`);
  }
  if (typeof entry.source !== "string" || entry.source.length === 0) {
    throw new ProjectSkillsError(`Inventory entry ${name} is missing source`);
  }
  if (!REMOTE_SOURCE_TYPES.has(entry.sourceType)) {
    throw new ProjectSkillsError(
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
    throw new ProjectSkillsError(
      `Inventory entry ${name} is blocked: skillPath is missing or unsafe`,
    );
  }
  if (typeof entry.computedHash !== "string" || !HASH_PATTERN.test(entry.computedHash)) {
    throw new ProjectSkillsError(
      `Inventory entry ${name} has a missing or invalid computedHash`,
    );
  }
}

export async function inspectInventory(skillsRoot) {
  const root = resolve(skillsRoot);
  await requireCanonicalDirectory(root, "Skills root");
  const canonicalDirectory = join(root, SKILLS_DIRECTORY);
  await requireCanonicalDirectory(canonicalDirectory, "Canonical skills inventory");
  const { lock, lockPath } = await loadLock(root);
  const names = Object.keys(lock.skills);
  if (names.length === 0) {
    throw new ProjectSkillsError("Project inventory contains no skills");
  }
  const sortedNames = [...names].sort((left, right) => left.localeCompare(right));
  if (names.some((name, index) => name !== sortedNames[index])) {
    throw new ProjectSkillsError("Project inventory keys are not in canonical order");
  }

  const diskEntries = await readdir(canonicalDirectory, { withFileTypes: true });
  const diskNames = diskEntries.map((entry) => entry.name).sort();
  if (
    diskEntries.some(
      (entry) => !entry.isDirectory() || entry.isSymbolicLink(),
    )
  ) {
    throw new ProjectSkillsError(
      `Canonical skills inventory contains a non-directory entry: ${canonicalDirectory}`,
    );
  }
  if (JSON.stringify(diskNames) !== JSON.stringify(sortedNames)) {
    const missing = sortedNames.filter((name) => !diskNames.includes(name));
    const untracked = diskNames.filter((name) => !sortedNames.includes(name));
    throw new ProjectSkillsError(
      `Canonical skills inventory does not match skills-lock.json (missing: ${missing.join(", ") || "none"}; untracked: ${untracked.join(", ") || "none"})`,
    );
  }

  const cliCompatibleHashes = {};
  const identities = {};
  const treeManifestHashes = {};
  for (const name of sortedNames) {
    const entry = lock.skills[name];
    validateLockEntry(name, entry);
    const directory = join(canonicalDirectory, name);
    await requireCanonicalDirectory(directory, `Canonical skill ${name}`);
    const skillEntrypoint = join(directory, "SKILL.md");
    let entrypointMetadata;
    try {
      entrypointMetadata = await stat(skillEntrypoint);
    } catch {
      throw new ProjectSkillsError(`Canonical skill ${name} is missing SKILL.md`);
    }
    if (!entrypointMetadata.isFile()) {
      throw new ProjectSkillsError(`Canonical skill ${name} has an invalid SKILL.md`);
    }
    const { cliCompatibleHash, treeManifestHash } =
      await computeSkillHashes(directory);
    cliCompatibleHashes[name] = cliCompatibleHash;
    treeManifestHashes[name] = treeManifestHash;
    identities[name] = Object.fromEntries(
      Object.entries(entry)
        .filter(([key]) => key !== "computedHash")
        .sort(([left], [right]) => left.localeCompare(right)),
    );
    if (entry.computedHash !== cliCompatibleHash) {
      throw new ProjectSkillsError(
        `Canonical content hash mismatch for ${name}: lock=${entry.computedHash} disk=${cliCompatibleHash}`,
      );
    }
  }

  return {
    cliCompatibleHashes,
    identities,
    lockPath,
    names: sortedNames,
    root,
    treeManifestHashes,
  };
}

export async function normalizeInventoryHashes(skillsRoot) {
  const root = resolve(skillsRoot);
  await requireCanonicalDirectory(root, "Skills root");
  const canonicalDirectory = join(root, SKILLS_DIRECTORY);
  await requireCanonicalDirectory(canonicalDirectory, "Canonical skills inventory");
  const { lock, lockPath, raw } = await loadLock(root);
  const names = Object.keys(lock.skills).sort((left, right) => left.localeCompare(right));
  const normalizedSkills = {};
  for (const name of names) {
    const entry = lock.skills[name];
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new ProjectSkillsError(`Inventory entry ${name} must be an object`);
    }
    const directory = join(canonicalDirectory, name);
    await requireCanonicalDirectory(directory, `Canonical skill ${name}`);
    normalizedSkills[name] = {
      ...entry,
      computedHash: await computeCliCompatibleSkillHash(directory),
    };
  }
  const normalized = `${JSON.stringify({ version: 1, skills: normalizedSkills }, null, 2)}\n`;
  if (normalized !== raw) await writeFile(lockPath, normalized, "utf8");
  return normalized !== raw;
}

function parseChangedPaths(repositoryRoot) {
  const tracked = git(repositoryRoot, ["diff", "--name-only", "HEAD", "--"]).stdout
    .split("\n")
    .filter(Boolean);
  const untracked = git(repositoryRoot, [
    "ls-files",
    "--others",
    "--exclude-standard",
    "--",
  ]).stdout
    .split("\n")
    .filter(Boolean);
  return [...new Set([...tracked, ...untracked])].sort();
}

function isScopedPath(path, scopedPaths) {
  return scopedPaths.some((scope) => path === scope || path.startsWith(`${scope}/`));
}

function requireCleanRepository(repositoryRoot) {
  const changedPaths = parseChangedPaths(repositoryRoot);
  if (changedPaths.length > 0) {
    throw new ProjectSkillsError(
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
    "bunx",
    ["--bun", `skills@${cliVersion}`, ...args],
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
    await writeFile(
      join(artifactDirectory, "metadata.json"),
      `${JSON.stringify(metadata, null, 2)}\n`,
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
    throw new ProjectSkillsError("skills-root must be a relative project path");
  }
  const skillsRoot = resolve(repositoryRoot, skillsRootInput);
  if (!isPathInside(skillsRoot, repositoryRoot)) {
    throw new ProjectSkillsError("skills-root must stay inside the caller repository");
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
    throw new ProjectSkillsError(
      `Repository root must be the Git top level: ${repositoryRoot}`,
    );
  }
  if (!CLI_VERSION_PATTERN.test(options.cliVersion)) {
    throw new ProjectSkillsError(
      `skills-cli-version must be an exact semver, received ${options.cliVersion}`,
    );
  }
  requireCleanRepository(repositoryRoot);
  const skillsRoot = resolveSkillsRoot(repositoryRoot, options.skillsRoot);
  if (options.normalizeLockHashes) await normalizeInventoryHashes(skillsRoot);
  const before = await inspectInventory(skillsRoot);
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
    throw new ProjectSkillsError(
      `Project Agent Skills update failed with status ${update.status}`,
    );
  }
  const deletionCheckFailures = parseDeletionCheckFailures(
    update.output ?? "",
  );
  if (deletionCheckFailures.length > 0) {
    throw new ProjectSkillsError(
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
      throw new ProjectSkillsError(
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
      throw new ProjectSkillsError(
        `find-skills full-depth repair failed with status ${repair.status}`,
      );
    }
  }
  if (options.normalizeLockHashes) await normalizeInventoryHashes(skillsRoot);
  const after = await inspectInventory(skillsRoot);
  if (JSON.stringify(before.names) !== JSON.stringify(after.names)) {
    throw new ProjectSkillsError(
      "Automated refresh changed the project skill inventory; migrate additions, deletions, or renames manually from source evidence",
    );
  }
  const changedIdentities = before.names.filter(
    (name) =>
      JSON.stringify(before.identities[name]) !==
      JSON.stringify(after.identities[name]),
  );
  if (changedIdentities.length > 0) {
    throw new ProjectSkillsError(
      `Automated refresh changed source identity for existing skills: ${changedIdentities.join(", ")}`,
    );
  }

  const changedPaths = parseChangedPaths(repositoryRoot);
  const outsideScope = changedPaths.filter(
    (path) => !isScopedPath(path, scopedPaths),
  );
  if (outsideScope.length > 0) {
    throw new ProjectSkillsError(
      `Skills refresh changed files outside its generated scope: ${outsideScope.join(", ")}`,
    );
  }
  const changed = changedPaths.length > 0;
  const baseSha = git(repositoryRoot, ["rev-parse", "HEAD"]).stdout.trim();
  await createPatch(repositoryRoot, scopedPaths, resolve(options.artifactDirectory), {
    version: 2,
    baseSha,
    changed,
    identities: after.identities,
    skillsRoot: toGitPath(relative(repositoryRoot, skillsRoot)) || ".",
    scopedPaths,
    treeManifestHashes: after.treeManifestHashes,
  });
  return { baseSha, changed, changedPaths, scopedPaths };
}

function validateBranch(branch) {
  if (
    !BRANCH_PATTERN.test(branch) ||
    branch.endsWith("/") ||
    branch.endsWith(".") ||
    branch.includes("@{")
  ) {
    throw new ProjectSkillsError(`PR branch is not a safe Git branch name: ${branch}`);
  }
}

function parseJsonOutput(value, label) {
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new ProjectSkillsError(`${label} returned invalid JSON: ${error.message}`);
  }
}

export async function publishProjectSkills(options) {
  const repositoryRoot = resolve(options.repositoryRoot);
  await requireCanonicalDirectory(repositoryRoot, "Repository root");
  requireCleanRepository(repositoryRoot);
  validateBranch(options.branch);
  if (!options.title.trim() || !options.body.trim()) {
    throw new ProjectSkillsError("PR title and body must not be empty");
  }
  const artifactDirectory = resolve(options.artifactDirectory);
  const metadata = parseJsonOutput(
    await readFile(join(artifactDirectory, "metadata.json"), "utf8"),
    "Artifact metadata",
  );
  if (
    metadata.version !== 2 ||
    !metadata.changed ||
    !metadata.identities ||
    typeof metadata.identities !== "object" ||
    !Array.isArray(metadata.scopedPaths) ||
    typeof metadata.baseSha !== "string" ||
    typeof metadata.skillsRoot !== "string" ||
    !metadata.treeManifestHashes ||
    typeof metadata.treeManifestHashes !== "object"
  ) {
    throw new ProjectSkillsError("Skills update artifact metadata is invalid");
  }
  const currentSha = git(repositoryRoot, ["rev-parse", "HEAD"]).stdout.trim();
  if (currentSha !== metadata.baseSha) {
    throw new ProjectSkillsError(
      `Publish checkout does not match refresh base: expected ${metadata.baseSha}, received ${currentSha}`,
    );
  }
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
      "--name-only",
      `${metadata.baseSha}...${remoteBranchRef}`,
      "--",
    ]).stdout
      .split("\n")
      .filter(Boolean);
    const foreignPaths = ownedPaths.filter(
      (path) => !isScopedPath(path, metadata.scopedPaths),
    );
    if (foreignPaths.length > 0) {
      throw new ProjectSkillsError(
        `Existing PR branch contains files outside the generated scope: ${foreignPaths.join(", ")}`,
      );
    }
    git(repositoryRoot, ["switch", "--create", options.branch, "--track", remoteBranchRef]);
    git(repositoryRoot, [
      "restore",
      `--source=${metadata.baseSha}`,
      "--staged",
      "--worktree",
      "--",
      ...metadata.scopedPaths,
    ]);
    git(repositoryRoot, ["clean", "-fd", "--", ...metadata.scopedPaths]);
  } else {
    git(repositoryRoot, ["switch", "--create", options.branch, metadata.baseSha]);
  }
  git(repositoryRoot, [
    "apply",
    "--index",
    "--binary",
    join(artifactDirectory, "skills-update.patch"),
  ]);
  const publishedInventory = await inspectInventory(
    resolveSkillsRoot(repositoryRoot, metadata.skillsRoot),
  );
  if (
    JSON.stringify(publishedInventory.identities) !==
      JSON.stringify(metadata.identities) ||
    JSON.stringify(publishedInventory.treeManifestHashes) !==
      JSON.stringify(metadata.treeManifestHashes)
  ) {
    throw new ProjectSkillsError(
      "Published inventory does not match the source identities and framed tree manifests produced by refresh",
    );
  }

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
    throw new ProjectSkillsError(
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
      throw new ProjectSkillsError(`Unexpected argument: ${token}`);
    }
    const key = token.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new ProjectSkillsError(`Missing value for --${key}`);
    }
    values[key] = value;
    index += 1;
  }
  return { command, values };
}

function booleanInput(value, label) {
  if (value === "true") return true;
  if (value === "false") return false;
  throw new ProjectSkillsError(`${label} must be true or false`);
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
      title: process.env.KGR_PR_TITLE ?? "",
    });
    await appendOutput("head_sha", result.headSha);
    await appendOutput("pr_url", result.pullRequestUrl);
    return;
  }
  if (command === "validate") {
    const root = resolveSkillsRoot(resolve(repositoryRoot), values["skills-root"]);
    if (
      booleanInput(
        values["normalize-lock-hashes"] ?? "false",
        "normalize-lock-hashes",
      )
    ) {
      await normalizeInventoryHashes(root);
    }
    await inspectInventory(root);
    return;
  }
  throw new ProjectSkillsError(`Unknown command: ${String(command)}`);
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

export { ProjectSkillsError };

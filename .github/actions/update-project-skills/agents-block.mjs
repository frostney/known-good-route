import { lstat, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { readDeliverySettings } from "../../../deliver/scripts/delivery-settings.mjs";

export const AGENTS_FILE = "AGENTS.md";
export const INSTALLED_SKILLS_DIRECTORY = ".agents/skills";
export const ROLE_KEY = "agents-role";
export const TEXT_KEY = "agents-text";
const MARKER_ID = "known-good-route:agents";
export const MARKER_BEGIN = `<!-- ${MARKER_ID}:begin -->`;
export const MARKER_END = `<!-- ${MARKER_ID}:end -->`;
const ROLES = new Set(["ambient", "entry-point"]);

function frontmatterLines(source) {
  const lines = source.replace(/^﻿/, "").split(/\r?\n/);
  if (lines[0] !== "---") return [];
  const end = lines.indexOf("---", 1);
  return end === -1 ? [] : lines.slice(1, end);
}

function stripPlainComment(value) {
  const comment = value.search(/\s#/);
  return (comment === -1 ? value : value.slice(0, comment)).trim();
}

function readScalar(raw, label) {
  const value = raw.trim();
  if (value.startsWith('"')) {
    const closing = value.lastIndexOf('"');
    if (closing === 0) throw new Error(`${label} has an unterminated double-quoted value`);
    try {
      return JSON.parse(value.slice(0, closing + 1));
    } catch {
      throw new Error(`${label} has an unsupported double-quoted value`);
    }
  }
  if (value.startsWith("'")) {
    const closing = value.lastIndexOf("'");
    if (closing === 0) throw new Error(`${label} has an unterminated single-quoted value`);
    return value.slice(1, closing).replaceAll("''", "'");
  }
  if (/^[|>]/.test(value)) {
    throw new Error(`${label} must be a single-line value, not a block scalar`);
  }
  return stripPlainComment(value);
}

// Reads `name` and the role keys under `metadata` from the subset of YAML that
// Agent Skills frontmatter uses. Skills that declare no role are never parsed
// further, so unrelated frontmatter cannot fail the block.
export function readRoleDeclaration(source, label) {
  let name;
  let metadataIndent;
  let inMetadata = false;
  const metadata = {};
  for (const line of frontmatterLines(source)) {
    if (/^\S/.test(line)) {
      inMetadata = false;
      const match = line.match(/^([A-Za-z0-9_-]+):(.*)$/);
      if (!match) continue;
      if (match[1] === "name") name = match[2];
      if (match[1] === "metadata") {
        if (match[2].includes(ROLE_KEY) || match[2].includes(TEXT_KEY)) {
          throw new Error(`${label} must declare ${ROLE_KEY} and ${TEXT_KEY} as block-style metadata entries`);
        }
        inMetadata = true;
        metadataIndent = undefined;
      }
      continue;
    }
    if (!inMetadata) continue;
    const match = line.match(/^(\s+)([A-Za-z0-9_.-]+):(.*)$/);
    if (!match) continue;
    metadataIndent ??= match[1].length;
    if (match[1].length === metadataIndent) metadata[match[2]] = match[3];
  }
  if (metadata[ROLE_KEY] === undefined && metadata[TEXT_KEY] === undefined) return null;

  const role = readScalar(metadata[ROLE_KEY] ?? "", `${label} ${ROLE_KEY}`);
  if (!ROLES.has(role)) {
    throw new Error(`${label} declares ${ROLE_KEY} "${role}"; use ambient or entry-point`);
  }
  const text = readScalar(metadata[TEXT_KEY] ?? "", `${label} ${TEXT_KEY}`);
  if (!text) throw new Error(`${label} declares ${ROLE_KEY} without ${TEXT_KEY}`);
  const skillName = name === undefined ? "" : readScalar(name, `${label} name`);
  if (!skillName) throw new Error(`${label} declares a role without a name`);
  return { name: skillName, role, text };
}

export async function collectSkillRoles(projectRoot) {
  const directory = join(projectRoot, INSTALLED_SKILLS_DIRECTORY);
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  const declarations = [];
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const skillFile = join(directory, entry.name, "SKILL.md");
    let source;
    try {
      source = await readFile(skillFile, "utf8");
    } catch (error) {
      if (error.code === "ENOENT" || error.code === "ENOTDIR") continue;
      throw error;
    }
    const declaration = readRoleDeclaration(source, `${INSTALLED_SKILLS_DIRECTORY}/${entry.name}/SKILL.md`);
    if (declaration) declarations.push(declaration);
  }
  return declarations.sort((left, right) =>
    left.role === right.role
      ? (left.name < right.name ? -1 : left.name > right.name ? 1 : 0)
      : left.role === "ambient" ? -1 : 1,
  );
}

function deliveryLine(settings) {
  const source = settings.file === null ? "defaults, no `ORCHESTRATION.md`" : "`ORCHESTRATION.md`";
  const endpoint = `the \`${settings.endpoint}\` endpoint`;
  return settings["entry-points"] === "stop"
    ? `Delivery (${source}): entry points stop after their own step, and \`/deliver\` stops at ${endpoint}.`
    : `Delivery (${source}): entry points continue through \`/deliver\` to ${endpoint}.`;
}

export function renderRegion(declarations, settings) {
  const lines = [
    MARKER_BEGIN,
    "",
    "## Agent skills",
    "",
    `Generated from the \`metadata.${ROLE_KEY}\` and \`metadata.${TEXT_KEY}\` of the skills installed in \`${INSTALLED_SKILLS_DIRECTORY}\`. Edit outside the \`${MARKER_ID}\` markers only.`,
    "",
    deliveryLine(settings),
    "",
  ];
  if (declarations.length === 0) {
    lines.push(`No installed skill declares \`metadata.${ROLE_KEY}\`.`);
  }
  for (const { name, role, text } of declarations) {
    lines.push(role === "ambient" ? `- Always apply \`${name}\`: ${text}` : `- Start with \`/${name}\`: ${text}`);
  }
  lines.push("", MARKER_END);
  return lines.join("\n");
}

// A marker counts only as a whole line; mid-line mentions are prose.
function findMarkerLine(text, marker) {
  let found = -1;
  let from = 0;
  for (;;) {
    const position = text.indexOf(marker, from);
    if (position === -1) return found;
    const after = position + marker.length;
    const atLineStart = position === 0 || text[position - 1] === "\n";
    const atLineEnd = after === text.length || text[after] === "\n" ||
      (text[after] === "\r" && (after + 1 === text.length || text[after + 1] === "\n"));
    if (atLineStart && atLineEnd) {
      if (found !== -1) {
        throw new Error(`${AGENTS_FILE} contains "${marker}" on more than one line; keep exactly one block`);
      }
      found = position;
    }
    from = position + 1;
  }
}

function endsWithBlankLine(text) {
  return /\r?\n\r?\n$/.test(text);
}

// The desired file content. Text outside the markers is kept byte for byte.
// Without any declared role, a file that has no block stays as it is.
export function spliceRegion(existing, declarations, settings) {
  const begin = existing === null ? -1 : findMarkerLine(existing, MARKER_BEGIN);
  const end = existing === null ? -1 : findMarkerLine(existing, MARKER_END);
  if (begin === -1 && end === -1) {
    if (declarations.length === 0) return existing;
    const region = renderRegion(declarations, settings);
    if (existing === null || existing === "") return `# Agent Instructions\n\n${region}\n`;
    const separator = endsWithBlankLine(existing) ? "" : existing.endsWith("\n") ? "\n" : "\n\n";
    return `${existing}${separator}${region}\n`;
  }
  if (begin === -1 || end === -1 || end < begin) {
    throw new Error(
      `${AGENTS_FILE} has a corrupt ${MARKER_ID} marker pair; restore "${MARKER_BEGIN}" on its own line before "${MARKER_END}", or remove both`,
    );
  }
  return existing.slice(0, begin) + renderRegion(declarations, settings) + existing.slice(end + MARKER_END.length);
}

async function readExisting(path) {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function desiredAgentsFile(projectRoot) {
  const path = join(projectRoot, AGENTS_FILE);
  const existing = await readExisting(path);
  const desired = spliceRegion(
    existing,
    await collectSkillRoles(projectRoot),
    await readDeliverySettings(projectRoot),
  );
  return { desired, existing, path };
}

export async function writeAgentsBlock(projectRoot) {
  const { desired, existing, path } = await desiredAgentsFile(projectRoot);
  if (desired === existing) return { changed: false, path };
  // Renaming over a symlink would replace the link with a regular file.
  if (existing !== null && (await lstat(path)).isSymbolicLink()) {
    throw new Error(`${path} is a symlink; keep the skills block in a regular AGENTS.md`);
  }
  const staging = `${path}.${process.pid}.tmp`;
  try {
    await writeFile(staging, desired, "utf8");
    await rename(staging, path);
  } finally {
    await rm(staging, { force: true });
  }
  return { changed: true, path };
}

export async function verifyAgentsBlock(projectRoot) {
  const { desired, existing, path } = await desiredAgentsFile(projectRoot);
  return { inSync: desired === existing, path };
}

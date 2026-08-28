import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  type Dirent,
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
} from 'node:fs';
import path from 'node:path';

import { SyntaxKind } from 'typescript/unstable/ast';
import { createScanner } from 'typescript/unstable/ast/scanner';

import {
  type DecisionContractArtifact,
  type DecisionContractCheck,
  decisionContractArtifactSchema,
} from './schema';

const contractDirectory = 'docs/decision-contracts';
const maximumContractBytes = 256 * 1024;
const maximumFileBytes = 2 * 1024 ** 2;
const maximumFiles = 20_000;
const maximumMatches = 5;

type ArtifactEntry = Readonly<{
  artifact: DecisionContractArtifact;
  path: string;
}>;

export type ValidationInput = Readonly<{
  baseArtifacts: readonly ArtifactEntry[];
  body: string;
  changedPaths: readonly string[];
  headPath: string;
}>;

export function validateDecisionContracts(input: ValidationInput) {
  const cwd = realpathSync(path.resolve(input.headPath));
  const errors: string[] = [];
  const section = markdownSection(input.body, 'Decision Contract');
  if (section === undefined) {
    return { errors: ['Missing ## Decision Contract section.'], ok: false };
  }
  const reference = normalizeReference(markdownField(section, 'Contract path'));
  const artifacts = readHeadContracts(cwd, errors);
  validateMergedContracts(input.baseArtifacts, artifacts, errors);
  executeContracts(artifacts, cwd, errors);
  const touched = touchedContracts(input.changedPaths, artifacts);
  validateReference({ artifacts, errors, reference, touched });
  return { errors, ok: errors.length === 0 };
}

function validateReference(input: {
  artifacts: readonly ArtifactEntry[];
  errors: string[];
  reference: string;
  touched: readonly string[];
}) {
  if (!input.reference) {
    if (input.touched.length > 0) {
      input.errors.push(
        `Additive change modifies a maintained decision contract: ${input.touched.join(', ')}. Set Contract path.`,
      );
    }
    return;
  }
  if (
    !input.reference.startsWith(`${contractDirectory}/`) ||
    !input.reference.endsWith('.json')
  ) {
    input.errors.push(
      'Contract path must name a JSON file under docs/decision-contracts/.',
    );
  } else if (!input.artifacts.some(({ path: entry }) => entry === input.reference)) {
    input.errors.push(
      `Decision contract does not exist or is invalid: ${input.reference}`,
    );
  }
  const unrelated = input.touched.filter((entry) => entry !== input.reference);
  if (unrelated.length > 0) {
    input.errors.push(
      `Change modifies paths owned by another contract: ${unrelated.join(', ')}`,
    );
  }
}

function readHeadContracts(cwd: string, errors: string[]) {
  const root = safePath(cwd, contractDirectory, errors);
  if (!(root && existsSync(root))) {
    return [];
  }
  let files: string[];
  try {
    files = collectFiles(root);
  } catch (error) {
    errors.push(errorMessage(error));
    return [];
  }
  const entries: ArtifactEntry[] = [];
  for (const file of files.filter((entry) => entry.endsWith('.json'))) {
    const relative = normalizePath(path.relative(cwd, file));
    if (lstatSync(file).size > maximumContractBytes) {
      errors.push(`Decision contract exceeds 256 KiB: ${relative}`);
      continue;
    }
    try {
      const parsed = decisionContractArtifactSchema.safeParse(
        JSON.parse(readFileSync(file, 'utf8')),
      );
      if (parsed.success) {
        entries.push({ artifact: parsed.data, path: relative });
      } else {
        errors.push(
          `Decision contract ${relative} is invalid: ${parsed.error.issues
            .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
            .join('; ')}`,
        );
      }
    } catch (error) {
      errors.push(`Decision contract ${relative} is not JSON: ${errorMessage(error)}`);
    }
  }
  return entries;
}

function validateMergedContracts(
  base: readonly ArtifactEntry[],
  current: readonly ArtifactEntry[],
  errors: string[],
) {
  const currentByPath = new Map(
    current.map((entry) => [entry.path, entry.artifact]),
  );
  for (const previous of base) {
    const next = currentByPath.get(previous.path);
    if (!next) {
      errors.push(`Merged decision contract was removed: ${previous.path}`);
      continue;
    }
    if (
      next.authoritativeEndState !== previous.artifact.authoritativeEndState ||
      next.decisionSource !== previous.artifact.decisionSource
    ) {
      errors.push(`Merged decision contract changed its authority: ${previous.path}`);
    }
    for (const field of [
      'ownedPaths',
      'rejectedAlternatives',
      'requiredAbsent',
      'requiredPresent',
    ] as const) {
      const retained = new Set(next[field].map(inventoryKey));
      if (previous.artifact[field].some((value) => !retained.has(inventoryKey(value)))) {
        errors.push(`Merged decision contract weakened ${field}: ${previous.path}`);
      }
    }
  }
}

function executeContracts(
  artifacts: readonly ArtifactEntry[],
  cwd: string,
  errors: string[],
) {
  const textCache = new Map<string, string>();
  for (const { artifact } of artifacts) {
    executeChecks(artifact.requiredPresent, true, cwd, errors, textCache);
    executeChecks(artifact.requiredAbsent, false, cwd, errors, textCache);
  }
}

function executeChecks(
  checks: readonly DecisionContractCheck[],
  present: boolean,
  cwd: string,
  errors: string[],
  textCache: Map<string, string>,
) {
  for (const check of checks) {
    const resolved = safePath(cwd, check.path, errors);
    if (!resolved) {
      continue;
    }
    executeCheck(check, resolved, present, errors, textCache);
  }
}

function executeCheck(
  check: DecisionContractCheck,
  resolved: string,
  present: boolean,
  errors: string[],
  textCache: Map<string, string>,
) {
  if (check.kind === 'path') {
    if (existsSync(resolved) !== present) {
      errors.push(
        `Required ${present ? 'present' : 'absent'} path failed: ${check.path}`,
      );
    }
  } else if (check.kind === 'jsonPointer') {
    executeJsonPointer(check, resolved, present, errors, textCache);
  } else if (check.kind === 'symbol') {
    executeSymbol(check, resolved, present, errors, textCache);
  } else if (check.kind === 'sourcePattern') {
    executeVersionLadder(check, resolved, present, errors);
  } else {
    executeContentHash(check, resolved, present, errors);
  }
}

function executeJsonPointer(
  check: Extract<DecisionContractCheck, { kind: 'jsonPointer' }>,
  resolved: string,
  present: boolean,
  errors: string[],
  textCache: Map<string, string>,
) {
  const file = singleFile(resolved, present, check.path, errors, 'JSON pointer');
  if (!file) {
    return;
  }
  let document: unknown;
  try {
    const text = textCache.get(file) ?? readFileSync(file, 'utf8');
    textCache.set(file, text);
    document = JSON.parse(text);
  } catch (error) {
    errors.push(`JSON pointer path is not valid JSON: ${check.path} (${errorMessage(error)})`);
    return;
  }
  if ((valueAtJsonPointer(document, check.pointer) === check.equals) !== present) {
    errors.push(
      `Required ${present ? 'present' : 'absent'} JSON pointer failed: ${check.path} ${check.pointer}`,
    );
  }
}

function executeSymbol(
  check: Extract<DecisionContractCheck, { kind: 'symbol' }>,
  resolved: string,
  present: boolean,
  errors: string[],
  textCache: Map<string, string>,
) {
  let text = textCache.get(resolved);
  if (text === undefined) {
    const files = filesAt(resolved, present, check.path, errors);
    if (!files) {
      return;
    }
    text = files.map((file) => readFileSync(file, 'utf8')).join('\n');
    textCache.set(resolved, text);
  }
  if (text.includes(check.symbol) !== present) {
    errors.push(
      `Required ${present ? 'present' : 'absent'} symbol failed: ${check.path} ${JSON.stringify(check.symbol)}`,
    );
  }
}

function executeVersionLadder(
  check: Extract<DecisionContractCheck, { kind: 'sourcePattern' }>,
  resolved: string,
  present: boolean,
  errors: string[],
) {
  if (present) {
    errors.push(`versionLadder is an absence rule: ${check.path}`);
    return;
  }
  const files = filesAt(resolved, false, check.path, errors)?.filter(
    (file) =>
      /\.tsx?$/.test(file) &&
      !/\.(?:test|spec)\.tsx?$/.test(file) &&
      !file.endsWith('.d.ts'),
  );
  if (!files) {
    return;
  }
  const matches = files.flatMap((file) =>
    scanVersionLadder(readFileSync(file, 'utf8')).map(
      (token) => `${token} in ${path.relative(resolved, file) || path.basename(file)}`,
    ),
  );
  if (matches.length > 0) {
    errors.push(
      `Required absent versionLadder failed: ${check.path} retains ${matches.slice(0, maximumMatches).join('; ')}`,
    );
  }
}

function executeContentHash(
  check: Extract<DecisionContractCheck, { kind: 'contentHash' }>,
  resolved: string,
  present: boolean,
  errors: string[],
) {
  if (!present) {
    errors.push(`contentHash is a presence rule: ${check.path}`);
    return;
  }
  const file = singleFile(resolved, true, check.path, errors, 'content hash');
  if (!file) {
    return;
  }
  const actual = createHash('sha256').update(readFileSync(file)).digest('hex');
  if (actual !== check.sha256) {
    errors.push(`Required content hash failed: ${check.path}`);
  }
}

function singleFile(
  resolved: string,
  required: boolean,
  displayPath: string,
  errors: string[],
  label: string,
) {
  const files = filesAt(resolved, required, displayPath, errors);
  if (files?.length === 1) {
    return files[0];
  }
  if (files && (required || files.length > 0)) {
    errors.push(`${label} path must be one file: ${displayPath}`);
  }
}

function filesAt(
  resolved: string,
  required: boolean,
  displayPath: string,
  errors: string[],
) {
  if (!existsSync(resolved)) {
    if (required) {
      errors.push(`Required path is missing: ${displayPath}`);
    }
    return required ? undefined : [];
  }
  const stat = lstatSync(resolved);
  if (stat.isFile()) {
    return [resolved];
  }
  if (stat.isDirectory()) {
    try {
      return collectFiles(resolved);
    } catch (error) {
      errors.push(errorMessage(error));
      return;
    }
  }
  errors.push(`Decision check path is not a file or directory: ${displayPath}`);
}

function collectFiles(root: string) {
  const files: string[] = [];
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop();
    if (!directory) {
      continue;
    }
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      collectEntry(path.join(directory, entry.name), entry, files, pending, root);
    }
  }
  return files;
}

function collectEntry(
  entryPath: string,
  entry: Dirent,
  files: string[],
  pending: string[],
  root: string,
) {
  if (entry.isSymbolicLink()) {
    throw new Error(`Decision check cannot inspect a symlink: ${entryPath}`);
  }
  if (entry.isDirectory()) {
    pending.push(entryPath);
  } else if (entry.isFile()) {
    if (lstatSync(entryPath).size > maximumFileBytes) {
      throw new Error(`Decision check cannot inspect a file larger than 2 MiB: ${entryPath}`);
    }
    files.push(entryPath);
    if (files.length > maximumFiles) {
      throw new Error(`Decision check exceeded ${maximumFiles} files: ${root}`);
    }
  }
}

function safePath(cwd: string, reference: string, errors: string[]) {
  const resolved = path.resolve(cwd, reference);
  const relative = path.relative(cwd, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    errors.push(`Decision check escapes the repository: ${reference}`);
    return;
  }
  let current = cwd;
  for (const component of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    try {
      if (lstatSync(current).isSymbolicLink()) {
        errors.push(`Decision check path contains a symlink: ${reference}`);
        return;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        errors.push(
          `Decision check could not inspect path components: ${reference} (${errorMessage(error)})`,
        );
        return;
      }
    }
  }
  return resolved;
}

function scanVersionLadder(source: string) {
  const scanner = createScanner(true, undefined, source);
  const matches = new Set<string>();
  let previousEnd = -1;
  for (
    let token = scanToken(scanner, previousEnd);
    token !== SyntaxKind.EndOfFile;
    token = scanToken(scanner, previousEnd)
  ) {
    previousEnd = scanner.getTokenEnd();
    if (token === SyntaxKind.Identifier) {
      const value = scanner.getTokenText();
      if (/(?:_?[vV]\d+|Version\d+)$/.test(value)) {
        matches.add(`identifier ${value}`);
      }
    } else if (
      token === SyntaxKind.StringLiteral ||
      token === SyntaxKind.NoSubstitutionTemplateLiteral
    ) {
      const value = scanner.getTokenValue();
      if (!/^https?:\/\//i.test(value) && /(?:^v\d+$|[./_-]v\d+$|Version\d+$)/i.test(value)) {
        matches.add(`literal ${JSON.stringify(value)}`);
      }
    }
  }
  return [...matches].sort((left, right) => left.localeCompare(right));
}

function scanToken(
  scanner: ReturnType<typeof createScanner>,
  previousEnd: number,
) {
  let token = scanner.scan();
  if (token === SyntaxKind.SlashToken) {
    token = scanner.reScanSlashToken();
  }
  if (token !== SyntaxKind.EndOfFile && scanner.getTokenEnd() <= previousEnd) {
    scanner.resetTokenState(previousEnd + 1);
    token = scanner.scan();
  }
  return token;
}

function valueAtJsonPointer(document: unknown, pointer: string) {
  let current = document;
  for (const encoded of pointer.slice(1).split('/')) {
    const key = encoded.replaceAll('~1', '/').replaceAll('~0', '~');
    if (
      current === null ||
      typeof current !== 'object' ||
      !Object.hasOwn(current, key)
    ) {
      return;
    }
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function touchedContracts(
  changedPaths: readonly string[],
  artifacts: readonly ArtifactEntry[],
) {
  return artifacts
    .filter(({ artifact, path: contractPath }) =>
      changedPaths.some((changed) =>
        [contractPath, ...artifact.ownedPaths].some((owned) => ownsPath(owned, changed)),
      ),
    )
    .map(({ path: contractPath }) => contractPath)
    .sort((left, right) => left.localeCompare(right));
}

function markdownSection(body: string, heading: string) {
  const lines = body.split(/\r?\n/);
  const start = lines.findIndex(
    (line) => line.trim().toLowerCase() === `## ${heading}`.toLowerCase(),
  );
  if (start < 0) {
    return;
  }
  const end = lines.findIndex(
    (line, index) => index > start && /^##[ \t]+/.test(line),
  );
  return lines.slice(start + 1, end < 0 ? undefined : end).join('\n').trim();
}

function markdownField(section: string, label: string) {
  const pattern = new RegExp(`^-[ \\t]*${escapeRegExp(label)}[ \\t]*:`, 'i');
  const lines = section.split(/\r?\n/);
  const start = lines.findIndex((line) => pattern.test(line));
  if (start < 0) {
    return '';
  }
  const values = [lines[start]?.replace(pattern, '').trim() ?? ''];
  for (const line of lines.slice(start + 1)) {
    if (/^-[ \t]*[^:]+[ \t]*:/.test(line)) {
      break;
    }
    values.push(line.trim());
  }
  return values.join('\n').trim();
}

function readBaseContracts(revision: string, cwd: string) {
  return git(['ls-tree', '-r', '--name-only', revision, '--', contractDirectory], cwd)
    .split('\n')
    .filter((entry) => entry.endsWith('.json'))
    .map((contractPath) => ({
      artifact: decisionContractArtifactSchema.parse(
        JSON.parse(git(['show', `${revision}:${contractPath}`], cwd)),
      ),
      path: contractPath,
    }));
}

function ownsPath(owned: string, changed: string) {
  const left = normalizePath(owned);
  const right = normalizePath(changed);
  return right === left || right.startsWith(`${left}/`);
}

function git(args: readonly string[], cwd: string) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function requiredInput(name: string) {
  const value = process.env[`INPUT_${name.toUpperCase()}`]?.trim();
  if (!value) {
    throw new Error(`Missing required action input: ${name.toLowerCase().replaceAll('_', '-')}`);
  }
  return value;
}

export function runAction() {
  const baseSha = requiredInput('BASE-SHA');
  const headSha = requiredInput('HEAD-SHA');
  const headPath = realpathSync(path.resolve(requiredInput('HEAD-PATH')));
  const workspace = realpathSync(path.resolve(process.env.GITHUB_WORKSPACE ?? process.cwd()));
  if (git(['rev-parse', 'HEAD'], workspace).trim() !== baseSha) {
    throw new Error('Trusted action workspace is not the exact pull-request base.');
  }
  if (git(['rev-parse', 'HEAD'], headPath).trim() !== headSha) {
    throw new Error('Detached data tree is not the exact pull-request head.');
  }
  const result = validateDecisionContracts({
    baseArtifacts: readBaseContracts(baseSha, workspace),
    body: process.env['INPUT_PULL-REQUEST-BODY'] ?? '',
    changedPaths: git(['diff', '--name-only', baseSha, headSha, '--'], workspace)
      .split('\n')
      .filter(Boolean),
    headPath,
  });
  for (const error of result.errors) {
    console.error(`::error::${error}`);
  }
  if (!result.ok) {
    process.exitCode = 1;
  } else {
    console.log('PR decision contract matches the exact head.');
  }
}

function inventoryKey(value: unknown) {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function normalizePath(value: string) {
  return value.replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/$/, '');
}

function normalizeReference(value: string) {
  return value.trim().replace(/^`|`$/g, '');
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

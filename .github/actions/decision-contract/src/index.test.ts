import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'bun:test';

import { validateDecisionContracts } from './index';
import {
  type DecisionContractArtifact,
  decisionContractArtifactSchema,
} from './schema';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe('trusted decision contract action', () => {
  it('accepts a bounded contract with an exact content seal', () => {
    const cwd = fixture();
    const sealed = path.join(cwd, 'src/current.ts');
    const artifact = contract({
      requiredPresent: [
        { kind: 'path', path: 'src/current.ts' },
        {
          kind: 'contentHash',
          path: 'src/current.ts',
          sha256: createHash('sha256')
            .update('export const current = true;')
            .digest('hex'),
        },
      ],
    });
    writeContract(cwd, artifact);

    expect(validate(cwd)).toEqual({ errors: [], ok: true });

    writeFileSync(sealed, 'export const current = false;');
    expect(validate(cwd).errors).toContainEqual(
      expect.stringContaining('Required content hash failed'),
    );
  });

  it('uses parsed JSON values rather than marker strings', () => {
    const cwd = fixture();
    writeFileSync(
      path.join(cwd, 'package.json'),
      JSON.stringify({
        decoy: 'bun scripts/check.ts',
        scripts: { check: 'true' },
      }),
    );
    writeContract(
      cwd,
      contract({
        requiredPresent: [
          {
            equals: 'bun scripts/check.ts',
            kind: 'jsonPointer',
            path: 'package.json',
            pointer: '/scripts/check',
          },
        ],
      }),
    );

    expect(validate(cwd).errors).toContainEqual(
      expect.stringContaining('JSON pointer failed'),
    );
  });

  it('rejects contract roots and checked files replaced by symlinks', () => {
    const cwd = fixture();
    const current = path.join(cwd, 'src/current.ts');
    writeFileSync(path.join(cwd, 'src/actual.ts'), 'export const current = true;');
    rmSync(current);
    symlinkSync('actual.ts', current);

    expect(validate(cwd).errors).toContainEqual(
      expect.stringContaining('contains a symlink'),
    );

    const rootFixture = fixture();
    const root = path.join(rootFixture, 'docs/decision-contracts');
    const copy = path.join(rootFixture, 'contract-copy');
    mkdirSync(copy);
    writeFileSync(path.join(copy, 'example.json'), JSON.stringify(contract()));
    rmSync(root, { recursive: true });
    symlinkSync('../contract-copy', root);

    expect(validate(rootFixture).errors).toContainEqual(
      expect.stringContaining('contains a symlink'),
    );
  });

  it('rejects source version ladders and weakening merged inventory', () => {
    const cwd = fixture();
    writeFileSync(path.join(cwd, 'src/versioned.ts'), 'export const runV7 = "prompt-v7";');
    const artifact = contract({
      requiredAbsent: [
        { kind: 'sourcePattern', path: 'src', rule: 'versionLadder' },
      ],
    });
    writeContract(cwd, artifact);

    const baseArtifacts = [
      { artifact, path: 'docs/decision-contracts/example.json' },
    ];
    expect(validate(cwd, baseArtifacts).errors).toContainEqual(
      expect.stringContaining('identifier runV7'),
    );

    writeContract(
      cwd,
      contract({ requiredAbsent: [{ kind: 'path', path: 'src/other.ts' }] }),
    );
    expect(validate(cwd, baseArtifacts).errors).toContainEqual(
      expect.stringContaining('weakened requiredAbsent'),
    );
  });

  it('executes the committed bundle with base code and an exact head data tree', () => {
    const base = fixture();
    git(['init'], base);
    git(['config', 'user.name', 'Decision Contract Test'], base);
    git(['config', 'user.email', 'decision-contract@example.test'], base);
    git(['add', '.'], base);
    git(['commit', '-m', 'base'], base);
    const baseSha = git(['rev-parse', 'HEAD'], base).trim();
    const head = mkdtempSync(path.join(tmpdir(), 'decision-contract-head-'));
    temporaryDirectories.push(head);
    rmSync(head, { recursive: true });
    git(['worktree', 'add', '-b', 'change', head], base);
    writeFileSync(path.join(head, 'unrelated.md'), 'Head data only.');
    git(['add', '.'], head);
    git(['commit', '-m', 'head'], head);
    const headSha = git(['rev-parse', 'HEAD'], head).trim();
    const bundle = path.resolve(import.meta.dir, '../dist/index.js');

    const output = execFileSync(process.execPath, [bundle], {
      cwd: base,
      encoding: 'utf8',
      env: {
        ...process.env,
        GITHUB_WORKSPACE: base,
        'INPUT_BASE-SHA': baseSha,
        'INPUT_HEAD-PATH': head,
        'INPUT_HEAD-SHA': headSha,
        'INPUT_PULL-REQUEST-BODY':
          '## Decision Contract\n\n- Contract path: docs/decision-contracts/example.json',
      },
    });

    expect(output).toContain('PR decision contract matches the exact head.');
  });
});

function fixture() {
  const cwd = mkdtempSync(path.join(tmpdir(), 'decision-contract-action-'));
  temporaryDirectories.push(cwd);
  mkdirSync(path.join(cwd, 'docs/decision-contracts'), { recursive: true });
  mkdirSync(path.join(cwd, 'src'));
  writeFileSync(path.join(cwd, 'src/current.ts'), 'export const current = true;');
  writeContract(cwd, contract());
  return cwd;
}

function writeContract(cwd: string, artifact: DecisionContractArtifact) {
  writeFileSync(
    path.join(cwd, 'docs/decision-contracts/example.json'),
    JSON.stringify(artifact),
  );
}

function contract(
  overrides: Partial<DecisionContractArtifact> = {},
): DecisionContractArtifact {
  return decisionContractArtifactSchema.parse({
    authoritativeEndState: 'One current runtime owns the maintained path.',
    decisionSource: 'docs/decision.md',
    ownedPaths: ['src'],
    rejectedAlternatives: ['Do not retain the previous runtime.'],
    requiredAbsent: [{ kind: 'path', path: 'src/retired.ts' }],
    requiredPresent: [{ kind: 'path', path: 'src/current.ts' }],
    retainedBoundaries: [],
    ...overrides,
  });
}

function validate(
  headPath: string,
  baseArtifacts: readonly Readonly<{
    artifact: DecisionContractArtifact;
    path: string;
  }>[] = [],
) {
  return validateDecisionContracts({
    baseArtifacts,
    body: '## Decision Contract\n\n- Contract path: docs/decision-contracts/example.json',
    changedPaths: [],
    headPath,
  });
}

function git(args: string[], cwd: string) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

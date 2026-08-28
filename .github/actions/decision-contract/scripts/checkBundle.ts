import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const repositoryRoot = path.resolve(import.meta.dir, '../../../..');
const actionRoot = path.join(
  repositoryRoot,
  '.github/actions/decision-contract',
);
const temporaryDirectory = mkdtempSync(
  path.join(tmpdir(), 'decision-contract-bundle-'),
);
const rebuiltBundle = path.join(temporaryDirectory, 'index.js');

try {
  execFileSync(
    process.execPath,
    [
      'build',
      path.join(actionRoot, 'src/run.ts'),
      '--target=node',
      '--minify',
      '--outfile',
      rebuiltBundle,
    ],
    { cwd: repositoryRoot, stdio: 'pipe' },
  );
  const committedBundle = path.join(actionRoot, 'dist/index.js');
  if (!readFileSync(rebuiltBundle).equals(readFileSync(committedBundle))) {
    throw new Error(
      'Trusted decision contract bundle is stale. Rebuild dist/index.js before committing.',
    );
  }
} finally {
  rmSync(temporaryDirectory, { force: true, recursive: true });
}

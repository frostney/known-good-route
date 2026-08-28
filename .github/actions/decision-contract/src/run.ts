import { runAction } from './index';

try {
  runAction();
} catch (error) {
  console.error(`::error::${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}

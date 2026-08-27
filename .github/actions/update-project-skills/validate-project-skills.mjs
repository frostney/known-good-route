#!/usr/bin/env bun

import { main } from "./update-project-skills.mjs";

try {
  await main(["validate", ...process.argv.slice(2)]);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`validate-project-skills: ${message}\n`);
  process.exitCode = 1;
}

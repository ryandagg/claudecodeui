#!/usr/bin/env node
/**
 * Test runner for the project's unit/integration suite.
 *
 * The suite uses Node's built-in test runner (`node:test` + `node:assert/strict`)
 * executed through `tsx` so TypeScript and the `@/` path aliases resolve without a
 * build step. Node 20 (the pinned runtime) does not expand globs passed to
 * `node --test`, so we enumerate the test files here and hand them over explicitly.
 *
 * Usage:
 *   node scripts/run-tests.js [--coverage] [--watch] [pathFilter ...]
 *
 * A pathFilter is a substring; only test files whose path contains at least one
 * of the provided filters run. With no filter, the whole suite runs.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Directories that hold source + tests. Everything else (build output, deps) is skipped.
const SEARCH_ROOTS = ['server', 'src', 'shared'];
const IGNORED_DIRECTORIES = new Set(['node_modules', 'dist', 'dist-server', '.git', 'coverage']);
const TEST_FILE_PATTERN = /\.test\.(?:ts|tsx|js|jsx|mjs|cjs)$/;

function collectTestFiles(startDir) {
  const found = [];
  const stack = [startDir];

  while (stack.length > 0) {
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue; // A search root may not exist in every checkout.
    }

    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!IGNORED_DIRECTORIES.has(entry.name)) {
          stack.push(path.join(current, entry.name));
        }
        continue;
      }

      if (entry.isFile() && TEST_FILE_PATTERN.test(entry.name)) {
        found.push(path.join(current, entry.name));
      }
    }
  }

  return found;
}

const rawArgs = process.argv.slice(2);
const flags = new Set(rawArgs.filter((arg) => arg.startsWith('--')));
const filters = rawArgs.filter((arg) => !arg.startsWith('--'));

const wantsCoverage = flags.has('--coverage');
const wantsWatch = flags.has('--watch');

let testFiles = SEARCH_ROOTS.flatMap((root) => collectTestFiles(path.join(projectRoot, root)));

if (filters.length > 0) {
  testFiles = testFiles.filter((file) => filters.some((filter) => file.includes(filter)));
}

testFiles.sort();

if (testFiles.length === 0) {
  console.error(
    filters.length > 0
      ? `No test files matched: ${filters.join(', ')}`
      : 'No test files found.',
  );
  process.exit(1);
}

const nodeArgs = ['--import', 'tsx', '--test'];
if (wantsCoverage) {
  // The pinned Node 20 runtime supports the coverage collector but not the
  // `--test-coverage-exclude` filter flag (added in newer releases), so the
  // report lists test files too; read the first-party source rows.
  nodeArgs.push('--experimental-test-coverage');
}
if (wantsWatch) {
  nodeArgs.push('--watch');
}
nodeArgs.push(...testFiles);

const child = spawn(process.execPath, nodeArgs, {
  cwd: projectRoot,
  stdio: 'inherit',
  env: process.env,
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});

#!/usr/bin/env node
/**
 * Test runner for the project's unit/integration suite.
 *
 * The suite uses Node's built-in test runner (`node:test` + `node:assert/strict`)
 * executed through `tsx` so TypeScript and the `@/` path aliases resolve without a
 * build step. Node 20 (the pinned runtime) does not expand globs passed to
 * `node --test`, so we enumerate the test files here and hand them over explicitly.
 *
 * The two halves of the codebase deliberately map the same `@/` alias to different
 * roots -- `tsconfig.json` sends it to /src, `server/tsconfig.json` sends it to
 * /server -- and tsx honours exactly one tsconfig per process (chosen from the cwd,
 * or from TSX_TSCONFIG_PATH). One process therefore cannot resolve both halves, so
 * we split the run into a backend group and a frontend group and spawn each with
 * its own tsconfig. Under --coverage that means one report per group.
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

const baseNodeArgs = ['--import', 'tsx', '--test'];
if (wantsCoverage) {
  // The pinned Node 20 runtime supports the coverage collector but not the
  // `--test-coverage-exclude` filter flag (added in newer releases), so the
  // report lists test files too; read the first-party source rows.
  baseNodeArgs.push('--experimental-test-coverage');
}
if (wantsWatch) {
  baseNodeArgs.push('--watch');
}

const serverRoot = path.join(projectRoot, `server${path.sep}`);

// Backend files resolve @/ against server/tsconfig.json; everything else (src, shared)
// against the root tsconfig, which tsx finds on its own from the cwd.
const groups = [
  {
    name: 'server',
    files: testFiles.filter((file) => file.startsWith(serverRoot)),
    tsconfig: path.join(projectRoot, 'server', 'tsconfig.json'),
  },
  {
    name: 'client',
    files: testFiles.filter((file) => !file.startsWith(serverRoot)),
    tsconfig: null,
  },
].filter((group) => group.files.length > 0);

function runGroup(group) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [...baseNodeArgs, ...group.files], {
      cwd: projectRoot,
      stdio: 'inherit',
      env: group.tsconfig
        ? { ...process.env, TSX_TSCONFIG_PATH: group.tsconfig }
        : process.env,
    });

    child.on('exit', (code, signal) => {
      if (signal) {
        process.kill(process.pid, signal);
        return;
      }
      resolve(code ?? 1);
    });
  });
}

// --watch never exits, so the groups have to run side by side; a normal run stays
// sequential to keep the two TAP streams from interleaving.
let exitCode = 0;
if (wantsWatch) {
  const codes = await Promise.all(groups.map(runGroup));
  exitCode = codes.find((code) => code !== 0) ?? 0;
} else {
  for (const group of groups) {
    if (groups.length > 1) {
      console.log(`\n# ${group.name} (${group.files.length} files)`);
    }
    const code = await runGroup(group);
    if (code !== 0) {
      exitCode = code;
    }
  }
}

process.exit(exitCode);

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  isBashCommandAllowed,
  isPathSafe,
  parseCommand,
  processBashCommands,
  processFileIncludes,
  replaceArguments,
  sanitizeOutput,
  validateCommand,
} from '../commandParser.js';

const makeTempDir = (label) => fs.mkdtemp(path.join(os.tmpdir(), `cg-cmd-${label}-`));

// ---------------------------------------------------------------------------
// parseCommand
// ---------------------------------------------------------------------------
test('parseCommand splits front matter from body', () => {
  const parsed = parseCommand('---\ndescription: Do a thing\nargument-hint: "<name>"\n---\n\nBody text.\n');
  assert.equal(parsed.data.description, 'Do a thing');
  assert.equal(parsed.data['argument-hint'], '<name>');
  assert.equal(parsed.content.trim(), 'Body text.');
  assert.match(parsed.raw, /^---/);
});

test('parseCommand returns empty data/content for plain text', () => {
  const parsed = parseCommand('just body, no front matter');
  assert.deepEqual(parsed.data, {});
  assert.equal(parsed.content.trim(), 'just body, no front matter');
});

// ---------------------------------------------------------------------------
// replaceArguments
// ---------------------------------------------------------------------------
test('replaceArguments substitutes $ARGUMENTS with all args joined', () => {
  assert.equal(replaceArguments('run $ARGUMENTS now', ['a', 'b', 'c']), 'run a b c now');
  assert.equal(replaceArguments('run $ARGUMENTS now', 'single'), 'run single now');
});

test('replaceArguments substitutes positional $1-$9 and blanks the missing ones', () => {
  assert.equal(replaceArguments('$1-$2-$3', ['x', 'y']), 'x-y-');
  assert.equal(replaceArguments('$1', 'solo'), 'solo');
});

test('replaceArguments returns input unchanged when empty or no args', () => {
  assert.equal(replaceArguments('', ['a']), '');
  assert.equal(replaceArguments('no placeholders', []), 'no placeholders');
  assert.equal(replaceArguments('$ARGUMENTS and $1', undefined), ' and ');
});

// ---------------------------------------------------------------------------
// isPathSafe
// ---------------------------------------------------------------------------
test('isPathSafe accepts paths contained within the base', () => {
  assert.equal(isPathSafe('sub/file.md', '/base'), true);
  assert.equal(isPathSafe('file.md', '/base'), true);
});

test('isPathSafe rejects traversal, absolute, and self-referential paths', () => {
  assert.equal(isPathSafe('../escape.md', '/base'), false);
  assert.equal(isPathSafe('/etc/passwd', '/base'), false);
  assert.equal(isPathSafe('.', '/base'), false); // relative === '' → rejected
});

// ---------------------------------------------------------------------------
// validateCommand
// ---------------------------------------------------------------------------
test('validateCommand allows an allowlisted command with safe args', () => {
  const result = validateCommand('git status --short');
  assert.equal(result.allowed, true);
  assert.equal(result.command, 'git');
  assert.deepEqual(result.args, ['status', '--short']);
});

test('validateCommand strips a leading path from the command name', () => {
  const result = validateCommand('/usr/bin/echo hello');
  assert.equal(result.allowed, true);
  assert.equal(result.command, 'echo');
  assert.deepEqual(result.args, ['hello']);
});

test('validateCommand rejects an empty command', () => {
  const result = validateCommand('   ');
  assert.equal(result.allowed, false);
  assert.match(result.error, /empty command/i);
});

test('validateCommand rejects shell operators', () => {
  const result = validateCommand('echo hi && rm -rf /');
  assert.equal(result.allowed, false);
  assert.match(result.error, /shell operators/i);
});

test('validateCommand rejects commands outside the allowlist', () => {
  const result = validateCommand('rm -rf /tmp/x');
  assert.equal(result.allowed, false);
  assert.match(result.error, /not in the allowlist/i);
});

test('validateCommand rejects dangerous metacharacters in arguments', () => {
  const result = validateCommand('echo `whoami`');
  assert.equal(result.allowed, false);
  assert.match(result.error, /dangerous characters/i);
});

// ---------------------------------------------------------------------------
// isBashCommandAllowed (deprecated wrapper)
// ---------------------------------------------------------------------------
test('isBashCommandAllowed returns a boolean mirroring validateCommand', () => {
  assert.equal(isBashCommandAllowed('ls -la'), true);
  assert.equal(isBashCommandAllowed('curl http://evil'), false);
});

// ---------------------------------------------------------------------------
// sanitizeOutput
// ---------------------------------------------------------------------------
test('sanitizeOutput keeps tab/newline/CR and strips other control chars', () => {
  assert.equal(sanitizeOutput('hi\tthere\nnext\r'), 'hi\tthere\nnext\r');
  assert.equal(sanitizeOutput('a\x00b\x07c\x7f'), 'abc');
  assert.equal(sanitizeOutput(''), '');
  assert.equal(sanitizeOutput(undefined), '');
});

// ---------------------------------------------------------------------------
// processFileIncludes
// ---------------------------------------------------------------------------
test('processFileIncludes inlines referenced files and recurses', async () => {
  const dir = await makeTempDir('include');
  try {
    await fs.writeFile(path.join(dir, 'inner.md'), 'INNER', 'utf8');
    await fs.writeFile(path.join(dir, 'outer.md'), 'see @inner.md', 'utf8');
    const content = 'top @outer.md end';
    const result = await processFileIncludes(content, dir);
    assert.equal(result, 'top see INNER end');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('processFileIncludes leaves content without includes unchanged', async () => {
  assert.equal(await processFileIncludes('plain text', '/base'), 'plain text');
  assert.equal(await processFileIncludes('', '/base'), '');
});

test('processFileIncludes throws on directory traversal', async () => {
  const dir = await makeTempDir('include-traversal');
  try {
    await assert.rejects(
      processFileIncludes('load @../secret.md', dir),
      /directory traversal detected/i,
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('processFileIncludes throws a clear error for a missing file', async () => {
  const dir = await makeTempDir('include-missing');
  try {
    await assert.rejects(processFileIncludes('load @nope.md', dir), /file not found/i);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('processFileIncludes enforces the maximum include depth', async () => {
  const dir = await makeTempDir('include-depth');
  try {
    // a → b → c → d: four levels of nesting exceeds MAX_INCLUDE_DEPTH (3).
    await fs.writeFile(path.join(dir, 'd.md'), 'DEEP', 'utf8');
    await fs.writeFile(path.join(dir, 'c.md'), 'c @d.md', 'utf8');
    await fs.writeFile(path.join(dir, 'b.md'), 'b @c.md', 'utf8');
    await fs.writeFile(path.join(dir, 'a.md'), 'a @b.md', 'utf8');
    await assert.rejects(processFileIncludes('start @a.md', dir), /maximum include depth/i);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// processBashCommands
// ---------------------------------------------------------------------------
test('processBashCommands runs an allowlisted command and inlines its output', async () => {
  const result = await processBashCommands('before\n!echo hello world\nafter');
  // echo appends its own trailing newline, which sanitizeOutput preserves.
  assert.match(result, /before\nhello world\n/);
  assert.match(result, /after$/);
  assert.equal(result.includes('!echo'), false);
});

test('processBashCommands returns content unchanged when no !commands present', async () => {
  assert.equal(await processBashCommands('nothing to run'), 'nothing to run');
  assert.equal(await processBashCommands(''), '');
});

test('processBashCommands throws when a command is not allowed', async () => {
  await assert.rejects(processBashCommands('\n!rm -rf /tmp/x'), /command not allowed/i);
});

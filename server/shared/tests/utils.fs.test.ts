import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  buildLookupMap,
  extractFirstValidJsonlData,
  findFilesRecursivelyModifiedAfter,
  findProviderSkillMarkdownFiles,
  findTopmostGitRoot,
  appendSessionCustomTitle,
  readFileTimestamps,
  readJsonConfig,
  readSessionActivityTimestamps,
  readSessionTimestamps,
  readSessionTitle,
  readProviderSessionActiveModelChange,
  readProviderSkillMarkdownDefinition,
  validateWorkspacePath,
  writeJsonConfig,
  writeProviderSessionActiveModelChange,
} from '@/shared/utils.js';

// Each test uses an isolated temp directory so real filesystem behavior is
// exercised without touching the developer's home or workspace.
const makeTempDir = (label: string) => fs.mkdtemp(path.join(os.tmpdir(), `cg-utils-${label}-`));

// ---------------------------------------------------------------------------
// readJsonConfig / writeJsonConfig
// ---------------------------------------------------------------------------
test('writeJsonConfig then readJsonConfig round-trips data and creates parent dirs', async () => {
  const dir = await makeTempDir('json');
  try {
    const filePath = path.join(dir, 'nested', 'deep', 'config.json');
    await writeJsonConfig(filePath, { hello: 'world', n: 1 });

    const raw = await fs.readFile(filePath, 'utf8');
    assert.ok(raw.endsWith('\n'), 'file should end with a trailing newline');

    assert.deepEqual(await readJsonConfig(filePath), { hello: 'world', n: 1 });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('readJsonConfig returns {} for a missing file', async () => {
  const dir = await makeTempDir('json-missing');
  try {
    assert.deepEqual(await readJsonConfig(path.join(dir, 'absent.json')), {});
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('readJsonConfig normalizes a non-object JSON payload to {}', async () => {
  const dir = await makeTempDir('json-array');
  try {
    const filePath = path.join(dir, 'arr.json');
    await fs.writeFile(filePath, '[1,2,3]', 'utf8');
    assert.deepEqual(await readJsonConfig(filePath), {});
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('readJsonConfig rethrows on invalid JSON', async () => {
  const dir = await makeTempDir('json-bad');
  try {
    const filePath = path.join(dir, 'bad.json');
    await fs.writeFile(filePath, '{ not valid', 'utf8');
    await assert.rejects(readJsonConfig(filePath));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// readProviderSessionActiveModelChange / writeProviderSessionActiveModelChange
// ---------------------------------------------------------------------------
test('provider session model change round-trips through an injected file path', async () => {
  const dir = await makeTempDir('model-change');
  try {
    const filePath = path.join(dir, 'changes.json');

    const initial = await readProviderSessionActiveModelChange('claude', 'sess-1', { filePath });
    assert.deepEqual(initial, {
      provider: 'claude',
      sessionId: 'sess-1',
      supported: true,
      changed: false,
      model: null,
    });

    const written = await writeProviderSessionActiveModelChange(
      'claude',
      { sessionId: 'sess-1', model: 'opus' },
      { filePath },
    );
    assert.equal(written.changed, true);
    assert.equal(written.model, 'opus');

    const readBack = await readProviderSessionActiveModelChange('claude', 'sess-1', { filePath });
    assert.equal(readBack.changed, true);
    assert.equal(readBack.model, 'opus');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('provider session model change reports unsupported without writing', async () => {
  const dir = await makeTempDir('model-unsupported');
  try {
    const filePath = path.join(dir, 'changes.json');
    const result = await writeProviderSessionActiveModelChange(
      'claude',
      { sessionId: 'sess-1', model: 'opus' },
      { filePath, supported: false },
    );
    assert.equal(result.supported, false);
    assert.equal(result.changed, false);
    // Nothing should have been persisted.
    await assert.rejects(fs.stat(filePath), { code: 'ENOENT' });

    const read = await readProviderSessionActiveModelChange('claude', 'sess-1', { filePath, supported: false });
    assert.equal(read.supported, false);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('provider session model change treats blank session id or model as no-op', async () => {
  const dir = await makeTempDir('model-blank');
  try {
    const filePath = path.join(dir, 'changes.json');

    const blankSession = await writeProviderSessionActiveModelChange(
      'claude',
      { sessionId: '   ', model: 'opus' },
      { filePath },
    );
    assert.equal(blankSession.changed, false);

    const blankModel = await writeProviderSessionActiveModelChange(
      'claude',
      { sessionId: 'sess-1', model: '   ' },
      { filePath },
    );
    assert.equal(blankModel.changed, false);

    // Reading a blank session id short-circuits to unsupported=false.
    const readBlank = await readProviderSessionActiveModelChange('claude', '   ', { filePath });
    assert.equal(readBlank.supported, false);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// findTopmostGitRoot
// ---------------------------------------------------------------------------
test('findTopmostGitRoot returns the highest ancestor holding a .git marker', async () => {
  const dir = await makeTempDir('git-root');
  try {
    const outerRepo = path.join(dir, 'outer');
    const innerRepo = path.join(outerRepo, 'packages', 'inner');
    await fs.mkdir(path.join(outerRepo, '.git'), { recursive: true });
    await fs.mkdir(path.join(innerRepo, '.git'), { recursive: true });
    const startDir = path.join(innerRepo, 'src');
    await fs.mkdir(startDir, { recursive: true });

    const topmost = await findTopmostGitRoot(startDir);
    assert.equal(topmost, path.resolve(outerRepo));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('findTopmostGitRoot detects a .git file (worktree) as a marker', async () => {
  const dir = await makeTempDir('git-file');
  try {
    const repo = path.join(dir, 'wt');
    await fs.mkdir(repo, { recursive: true });
    await fs.writeFile(path.join(repo, '.git'), 'gitdir: /somewhere/.git/worktrees/wt\n', 'utf8');
    assert.equal(await findTopmostGitRoot(repo), path.resolve(repo));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('findTopmostGitRoot returns null when no marker exists', async () => {
  const dir = await makeTempDir('git-none');
  try {
    const startDir = path.join(dir, 'a', 'b');
    await fs.mkdir(startDir, { recursive: true });
    assert.equal(await findTopmostGitRoot(startDir), null);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// findProviderSkillMarkdownFiles + readProviderSkillMarkdownDefinition
// ---------------------------------------------------------------------------
test('findProviderSkillMarkdownFiles scans direct children in non-recursive mode', async () => {
  const dir = await makeTempDir('skill-scan');
  try {
    await fs.mkdir(path.join(dir, 'alpha'), { recursive: true });
    await fs.writeFile(path.join(dir, 'alpha', 'SKILL.md'), '---\nname: alpha\n---\n', 'utf8');
    await fs.mkdir(path.join(dir, 'beta'), { recursive: true });
    await fs.writeFile(path.join(dir, 'beta', 'SKILL.md'), '---\nname: beta\n---\n', 'utf8');
    // A nested skill is NOT found in non-recursive mode.
    await fs.mkdir(path.join(dir, 'beta', 'nested'), { recursive: true });
    await fs.writeFile(path.join(dir, 'beta', 'nested', 'SKILL.md'), '---\nname: nested\n---\n', 'utf8');
    // A directory without SKILL.md is skipped.
    await fs.mkdir(path.join(dir, 'gamma'), { recursive: true });

    const files = await findProviderSkillMarkdownFiles(dir);
    assert.deepEqual(
      files,
      [path.join(dir, 'alpha', 'SKILL.md'), path.join(dir, 'beta', 'SKILL.md')].sort(),
    );

    const def = await readProviderSkillMarkdownDefinition(files[0]);
    assert.equal(def.name, 'alpha');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('findProviderSkillMarkdownFiles finds nested skills in recursive mode', async () => {
  const dir = await makeTempDir('skill-recursive');
  try {
    await fs.mkdir(path.join(dir, 'a', 'b', 'c'), { recursive: true });
    await fs.writeFile(path.join(dir, 'a', 'SKILL.md'), '---\nname: a\n---\n', 'utf8');
    await fs.writeFile(path.join(dir, 'a', 'b', 'c', 'SKILL.md'), '---\nname: c\n---\n', 'utf8');

    const files = await findProviderSkillMarkdownFiles(dir, { recursive: true });
    assert.equal(files.length, 2);
    assert.ok(files.includes(path.join(dir, 'a', 'SKILL.md')));
    assert.ok(files.includes(path.join(dir, 'a', 'b', 'c', 'SKILL.md')));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('findProviderSkillMarkdownFiles returns [] for a missing root', async () => {
  const dir = await makeTempDir('skill-missing');
  try {
    assert.deepEqual(await findProviderSkillMarkdownFiles(path.join(dir, 'nope')), []);
    assert.deepEqual(await findProviderSkillMarkdownFiles(path.join(dir, 'nope'), { recursive: true }), []);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// findFilesRecursivelyModifiedAfter
// ---------------------------------------------------------------------------
test('findFilesRecursivelyModifiedAfter collects matching files across subdirectories', async () => {
  const dir = await makeTempDir('find-files');
  try {
    await fs.mkdir(path.join(dir, 'sub'), { recursive: true });
    await fs.writeFile(path.join(dir, 'a.jsonl'), '{}', 'utf8');
    await fs.writeFile(path.join(dir, 'sub', 'b.jsonl'), '{}', 'utf8');
    await fs.writeFile(path.join(dir, 'sub', 'c.txt'), 'nope', 'utf8');

    const files = await findFilesRecursivelyModifiedAfter(dir, '.jsonl', null);
    assert.equal(files.length, 2);
    assert.ok(files.some((f) => f.endsWith('a.jsonl')));
    assert.ok(files.some((f) => f.endsWith(path.join('sub', 'b.jsonl'))));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('findFilesRecursivelyModifiedAfter respects the lastScanAt cutoff', async () => {
  const dir = await makeTempDir('find-files-after');
  try {
    await fs.writeFile(path.join(dir, 'old.jsonl'), '{}', 'utf8');
    // Cutoff in the future means nothing qualifies as "created after".
    const future = new Date(Date.now() + 60_000);
    assert.deepEqual(await findFilesRecursivelyModifiedAfter(dir, '.jsonl', future), []);

    // Cutoff in the past includes the file.
    const past = new Date(Date.now() - 60_000);
    const found = await findFilesRecursivelyModifiedAfter(dir, '.jsonl', past);
    assert.equal(found.length, 1);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('findFilesRecursivelyModifiedAfter finds a file created before the cutoff but modified after', async () => {
  // The regression this guards: filtering on creation time meant a transcript
  // created last week and appended to today was never re-read, so a rename or
  // new message made outside the app never reached the database.
  const dir = await makeTempDir('find-files-modified');
  try {
    const filePath = path.join(dir, 'appended.jsonl');
    await fs.writeFile(filePath, '{}', 'utf8');

    // Backdate creation well before the cutoff, but leave mtime after it.
    const longAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const cutoff = new Date(Date.now() - 60_000);
    await fs.utimes(filePath, longAgo, new Date());

    const found = await findFilesRecursivelyModifiedAfter(dir, '.jsonl', cutoff);
    assert.deepEqual(found, [filePath], 'a modified file must be re-read regardless of when it was created');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('findFilesRecursivelyModifiedAfter skips a file untouched since the cutoff', async () => {
  const dir = await makeTempDir('find-files-untouched');
  try {
    const filePath = path.join(dir, 'quiet.jsonl');
    await fs.writeFile(filePath, '{}', 'utf8');

    const longAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    await fs.utimes(filePath, longAgo, longAgo);

    const found = await findFilesRecursivelyModifiedAfter(dir, '.jsonl', new Date(Date.now() - 60_000));
    assert.deepEqual(found, [], 'unchanged files stay out of the incremental scan');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('findFilesRecursivelyModifiedAfter returns [] for a missing directory', async () => {
  const dir = await makeTempDir('find-files-missing');
  try {
    assert.deepEqual(await findFilesRecursivelyModifiedAfter(path.join(dir, 'nope'), '.jsonl', null), []);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// readFileTimestamps
// ---------------------------------------------------------------------------
test('readFileTimestamps returns ISO created/updated timestamps', async () => {
  const dir = await makeTempDir('timestamps');
  try {
    const filePath = path.join(dir, 'f.txt');
    await fs.writeFile(filePath, 'x', 'utf8');
    const stamps = await readFileTimestamps(filePath);
    assert.ok(stamps.createdAt && !Number.isNaN(new Date(stamps.createdAt).getTime()));
    assert.ok(stamps.updatedAt && !Number.isNaN(new Date(stamps.updatedAt).getTime()));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('readFileTimestamps returns {} for a missing file', async () => {
  const dir = await makeTempDir('timestamps-missing');
  try {
    assert.deepEqual(await readFileTimestamps(path.join(dir, 'nope.txt')), {});
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// readSessionActivityTimestamps / readSessionTimestamps
// ---------------------------------------------------------------------------
const writeTranscript = async (dir: string, lines: unknown[]): Promise<string> => {
  const filePath = path.join(dir, 'session.jsonl');
  await fs.writeFile(filePath, lines.map((line) => JSON.stringify(line)).join('\n'), 'utf8');
  return filePath;
};

test('readSessionActivityTimestamps reports the message time span', async () => {
  const dir = await makeTempDir('session-activity');
  try {
    const filePath = await writeTranscript(dir, [
      { timestamp: '2026-08-01T20:51:58.385Z' },
      { timestamp: '2026-08-01T20:52:01.684Z' },
    ]);

    assert.deepEqual(await readSessionActivityTimestamps(filePath), {
      createdAt: '2026-08-01T20:51:58.385Z',
      updatedAt: '2026-08-01T20:52:01.684Z',
    });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('readSessionActivityTimestamps takes the newest time, not the last line', async () => {
  const dir = await makeTempDir('session-activity-order');
  try {
    const filePath = await writeTranscript(dir, [
      { timestamp: '2026-08-01T10:00:00.000Z' },
      { timestamp: '2026-08-01T12:00:00.000Z' },
      { timestamp: '2026-08-01T11:00:00.000Z' },
    ]);

    const stamps = await readSessionActivityTimestamps(filePath);
    assert.equal(stamps.createdAt, '2026-08-01T10:00:00.000Z');
    assert.equal(stamps.updatedAt, '2026-08-01T12:00:00.000Z');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('readSessionActivityTimestamps skips malformed lines and unusable timestamps', async () => {
  const dir = await makeTempDir('session-activity-malformed');
  try {
    const filePath = path.join(dir, 'session.jsonl');
    await fs.writeFile(
      filePath,
      [
        '{ not json',
        JSON.stringify({ timestamp: 'not-a-date' }),
        JSON.stringify({ timestamp: 42 }),
        JSON.stringify({ noTimestamp: true }),
        '',
        JSON.stringify({ timestamp: '2026-08-01T09:00:00.000Z' }),
      ].join('\n'),
      'utf8',
    );

    assert.deepEqual(await readSessionActivityTimestamps(filePath), {
      createdAt: '2026-08-01T09:00:00.000Z',
      updatedAt: '2026-08-01T09:00:00.000Z',
    });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('readSessionActivityTimestamps returns {} when nothing is parseable', async () => {
  const dir = await makeTempDir('session-activity-empty');
  try {
    const filePath = await writeTranscript(dir, [{ noTimestamp: true }]);
    assert.deepEqual(await readSessionActivityTimestamps(filePath), {});
    assert.deepEqual(await readSessionActivityTimestamps(path.join(dir, 'missing.jsonl')), {});
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('readSessionTimestamps ignores mtime when the transcript has message times', async () => {
  const dir = await makeTempDir('session-timestamps');
  try {
    const filePath = await writeTranscript(dir, [
      { timestamp: '2026-08-01T20:51:58.385Z' },
      { timestamp: '2026-08-01T20:52:01.684Z' },
    ]);

    // Touching the file must not make a day-old conversation look current —
    // this is the regression that reordered the sidebar.
    const future = new Date('2026-08-02T17:18:01.072Z');
    await fs.utimes(filePath, future, future);

    const stamps = await readSessionTimestamps(filePath);
    assert.equal(stamps.updatedAt, '2026-08-01T20:52:01.684Z');
    assert.equal(stamps.createdAt, '2026-08-01T20:51:58.385Z');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('readSessionTimestamps falls back to file metadata without message times', async () => {
  const dir = await makeTempDir('session-timestamps-fallback');
  try {
    const filePath = await writeTranscript(dir, [{ noTimestamp: true }]);
    const stamps = await readSessionTimestamps(filePath);
    const fileStamps = await readFileTimestamps(filePath);

    assert.equal(stamps.updatedAt, fileStamps.updatedAt);
    assert.equal(stamps.createdAt, fileStamps.createdAt);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// buildLookupMap
// ---------------------------------------------------------------------------
test('buildLookupMap builds a first-seen key/value map from JSONL', async () => {
  const dir = await makeTempDir('lookup');
  try {
    const filePath = path.join(dir, 'index.jsonl');
    await fs.writeFile(
      filePath,
      [
        '{"sessionId":"s1","name":"First"}',
        '',
        '{"sessionId":"s1","name":"Second"}',
        '{"sessionId":"s2","name":"Other"}',
        '{"sessionId":"s3"}',
        'not-json',
      ].join('\n'),
      'utf8',
    );

    const map = await buildLookupMap(filePath, 'sessionId', 'name');
    assert.equal(map.get('s1'), 'First'); // first value wins
    assert.equal(map.get('s2'), 'Other');
    assert.equal(map.has('s3'), false); // missing value field is skipped
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('buildLookupMap returns an empty map for a missing file', async () => {
  const dir = await makeTempDir('lookup-missing');
  try {
    const map = await buildLookupMap(path.join(dir, 'nope.jsonl'), 'k', 'v');
    assert.equal(map.size, 0);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// extractFirstValidJsonlData
// ---------------------------------------------------------------------------
test('extractFirstValidJsonlData returns the first extractor match', async () => {
  const dir = await makeTempDir('extract');
  try {
    const filePath = path.join(dir, 'events.jsonl');
    await fs.writeFile(
      filePath,
      [
        '{"type":"noise"}',
        '{"type":"summary","title":"Hello"}',
        '{"type":"summary","title":"Second"}',
      ].join('\n'),
      'utf8',
    );

    const title = await extractFirstValidJsonlData<string>(filePath, (parsed) => {
      const row = parsed as Record<string, unknown>;
      return row?.type === 'summary' && typeof row.title === 'string' ? row.title : null;
    });
    assert.equal(title, 'Hello');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('extractFirstValidJsonlData returns null when nothing matches or file is missing', async () => {
  const dir = await makeTempDir('extract-none');
  try {
    const filePath = path.join(dir, 'events.jsonl');
    await fs.writeFile(filePath, '{"type":"noise"}\n', 'utf8');
    const none = await extractFirstValidJsonlData(filePath, () => null);
    assert.equal(none, null);

    const missing = await extractFirstValidJsonlData(path.join(dir, 'absent.jsonl'), () => 'x');
    assert.equal(missing, null);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// validateWorkspacePath
// ---------------------------------------------------------------------------
test('validateWorkspacePath rejects blank input', async () => {
  const result = await validateWorkspacePath('   ');
  assert.equal(result.valid, false);
  assert.match(result.error ?? '', /required/i);
});

test('validateWorkspacePath rejects system-critical directories', async () => {
  const root = await validateWorkspacePath('/');
  assert.equal(root.valid, false);

  const etc = await validateWorkspacePath('/etc');
  assert.equal(etc.valid, false);
  assert.match(etc.error ?? '', /system/i);
});

test('validateWorkspacePath never resolves a Windows path under process.cwd()', async () => {
  // Regression: path.resolve() is platform-bound, so on POSIX an absolute
  // Windows path degraded into a relative one and got appended to the cwd —
  // which then had a directory created at it, named with literal backslashes.
  if (process.platform === 'win32') {
    return;
  }

  for (const windowsPath of [
    '\\\\wsl$\\Ubuntu\\home\\me\\project',
    '\\\\some-server\\share\\project',
    'C:\\Users\\me\\project',
  ]) {
    const result = await validateWorkspacePath(windowsPath);
    if (result.valid) {
      assert.ok(
        !result.resolvedPath?.startsWith(process.cwd()),
        `${windowsPath} resolved under the cwd: ${result.resolvedPath}`,
      );
      assert.ok(!result.resolvedPath?.includes('\\'), `${windowsPath} kept backslashes`);
    }
  }
});

test('validateWorkspacePath rejects a bare relative path instead of resolving it', async () => {
  const result = await validateWorkspacePath('some-relative-dir');
  assert.equal(result.valid, false);
  assert.match(result.error ?? '', /absolute/i);
});

test('validateWorkspacePath accepts a real path within the workspace root', async () => {
  // WORKSPACES_ROOT defaults to the home directory; a temp dir under it validates.
  const home = os.homedir();
  const dir = await fs.mkdtemp(path.join(home, '.cg-utils-ws-'));
  try {
    const result = await validateWorkspacePath(dir);
    assert.equal(result.valid, true, result.error);
    assert.equal(result.resolvedPath, await fs.realpath(dir));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('validateWorkspacePath rejects a path outside the workspace root', async () => {
  // /var/tmp is explicitly allowed past the /var block but is outside $HOME,
  // so the workspace-root containment check should still reject it.
  const outside = await fs.mkdtemp(path.join('/var/tmp', 'cg-utils-outside-'));
  try {
    const result = await validateWorkspacePath(outside);
    assert.equal(result.valid, false);
    assert.match(result.error ?? '', /within the allowed workspace root/i);
  } finally {
    await fs.rm(outside, { recursive: true, force: true });
  }
});


// ---------------------------------------------------------------------------
// readSessionTitle / appendSessionCustomTitle
// ---------------------------------------------------------------------------
const writeTitleTranscript = async (dir: string, lines: unknown[]): Promise<string> => {
  const filePath = path.join(dir, 'titles.jsonl');
  await fs.writeFile(filePath, lines.map((line) => JSON.stringify(line)).join('\n'), 'utf8');
  return filePath;
};

test('readSessionTitle ranks a /rename above a generated title', async () => {
  const dir = await makeTempDir('title-precedence');
  try {
    // ai-title is written LAST; precedence must be by meaning, not position.
    const filePath = await writeTitleTranscript(dir, [
      { type: 'last-prompt', lastPrompt: 'raw first prompt text' },
      { type: 'custom-title', customTitle: 'my explicit rename' },
      { type: 'ai-title', aiTitle: 'Generated Summary' },
    ]);

    assert.equal(await readSessionTitle(filePath), 'my explicit rename');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('readSessionTitle falls back to ai-title when there is no rename', async () => {
  const dir = await makeTempDir('title-fallback');
  try {
    const withAiTitle = await writeTitleTranscript(dir, [
      { type: 'last-prompt', lastPrompt: 'raw prompt' },
      { type: 'ai-title', aiTitle: 'Generated Summary' },
    ]);
    assert.equal(await readSessionTitle(withAiTitle), 'Generated Summary');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('readSessionTitle never names a session after its latest prompt', async () => {
  // Regression: `last-prompt` is rewritten every turn, so treating it as a
  // title made the sidebar label follow whatever the user typed most recently.
  // A transcript with only last-prompt lines has no title at all.
  const dir = await makeTempDir('title-last-prompt');
  try {
    const filePath = await writeTitleTranscript(dir, [
      { type: 'last-prompt', lastPrompt: 'an early question' },
      { type: 'last-prompt', lastPrompt: 'a much later unrelated question' },
    ]);
    assert.equal(await readSessionTitle(filePath), null);

    // And it must not outrank a real title either.
    const withRename = await writeTitleTranscript(dir, [
      { type: 'custom-title', customTitle: 'my rename' },
      { type: 'last-prompt', lastPrompt: 'typed long after the rename' },
    ]);
    assert.equal(await readSessionTitle(withRename), 'my rename');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('readSessionTitle takes the most recent rename of the same rank', async () => {
  const dir = await makeTempDir('title-latest');
  try {
    const filePath = await writeTitleTranscript(dir, [
      { type: 'custom-title', customTitle: 'first rename' },
      { type: 'custom-title', customTitle: 'second rename' },
    ]);
    assert.equal(await readSessionTitle(filePath), 'second rename');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('readSessionTitle returns null for a transcript with no titles', async () => {
  const dir = await makeTempDir('title-none');
  try {
    const filePath = await writeTitleTranscript(dir, [{ type: 'user', text: 'hi' }]);
    assert.equal(await readSessionTitle(filePath), null);
    assert.equal(await readSessionTitle(path.join(dir, 'missing.jsonl')), null);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('appendSessionCustomTitle makes a rename readable back from the transcript', async () => {
  const dir = await makeTempDir('title-append');
  const previousHome = process.env.CLAUDE_HOME;
  process.env.CLAUDE_HOME = dir;
  try {
    const filePath = await writeTitleTranscript(dir, [{ type: 'ai-title', aiTitle: 'Generated' }]);

    assert.equal(await appendSessionCustomTitle(filePath, 'sess-1', 'renamed by the app'), true);
    assert.equal(await readSessionTitle(filePath), 'renamed by the app');

    // The file must stay valid JSONL for every other reader.
    const contents = await fs.readFile(filePath, 'utf8');
    for (const line of contents.trim().split('\n')) {
      JSON.parse(line);
    }
  } finally {
    if (previousHome === undefined) {
      delete process.env.CLAUDE_HOME;
    } else {
      process.env.CLAUDE_HOME = previousHome;
    }
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('appendSessionCustomTitle refuses to write outside CLAUDE_HOME', async () => {
  // The guard that stops an isolated run from reaching the user's real
  // transcripts. Transcript paths come from the database, so a copied database
  // still carries absolute paths into the real tree — redirecting CLAUDE_HOME
  // alone is not enough.
  const dir = await makeTempDir('title-outside-home');
  try {
    const outsidePath = path.join(dir, 'not-in-claude-home.jsonl');
    await fs.writeFile(outsidePath, JSON.stringify({ type: 'user' }), 'utf8');
    const contentsBefore = await fs.readFile(outsidePath, 'utf8');

    assert.equal(await appendSessionCustomTitle(outsidePath, 'sess-1', 'should not land'), false);
    assert.equal(await fs.readFile(outsidePath, 'utf8'), contentsBefore, 'file must be untouched');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('appendSessionCustomTitle writes when the path is inside CLAUDE_HOME', async () => {
  const dir = await makeTempDir('title-inside-home');
  const previousHome = process.env.CLAUDE_HOME;
  try {
    // Redirect the provider home at the temp tree — the isolation this exists
    // to make possible.
    process.env.CLAUDE_HOME = dir;
    const insidePath = path.join(dir, 'session.jsonl');
    await fs.writeFile(insidePath, JSON.stringify({ type: 'user' }) + '\n', 'utf8');

    assert.equal(await appendSessionCustomTitle(insidePath, 'sess-1', 'allowed'), true);
    assert.match(await fs.readFile(insidePath, 'utf8'), /"customTitle":"allowed"/);
  } finally {
    if (previousHome === undefined) {
      delete process.env.CLAUDE_HOME;
    } else {
      process.env.CLAUDE_HOME = previousHome;
    }
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('appendSessionCustomTitle reports failure when there is no transcript', async () => {
  const dir = await makeTempDir('title-append-missing');
  try {
    assert.equal(await appendSessionCustomTitle(path.join(dir, 'nope.jsonl'), 'sess-1', 'name'), false);
    // A blank rename is not written either.
    const filePath = await writeTitleTranscript(dir, [{ type: 'user', text: 'hi' }]);
    assert.equal(await appendSessionCustomTitle(filePath, 'sess-1', '   '), false);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

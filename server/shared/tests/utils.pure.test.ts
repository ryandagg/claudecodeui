import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  AppError,
  addUniqueProviderSkillSource,
  buildDefaultProviderCurrentActiveModel,
  createApiSuccessResponse,
  createCompleteMessage,
  createNormalizedMessage,
  generateMessageId,
  getPathBasename,
  normalizeProjectPath,
  normalizeProviderTimestamp,
  normalizeSessionName,
  parseIncomingJsonObject,
  readJsonRecord,
  readObjectRecord,
  readOptionalString,
  readProviderSkillMarkdownDefinitionFromContent,
  readStringArray,
  readStringRecord,
  sanitizeLeafDirectoryName,
  toWindowsUncPathForWsl,
  translateWindowsPathForPosix,
} from '@/shared/utils.js';
import type { ProviderSkillSource } from '@/shared/types.js';

// ---------------------------------------------------------------------------
// createApiSuccessResponse
// ---------------------------------------------------------------------------
test('createApiSuccessResponse wraps data in the standard success envelope', () => {
  assert.deepEqual(createApiSuccessResponse({ id: 1 }), { success: true, data: { id: 1 } });
  assert.deepEqual(createApiSuccessResponse(null), { success: true, data: null });
});

// ---------------------------------------------------------------------------
// AppError
// ---------------------------------------------------------------------------
test('AppError applies defaults when no options are supplied', () => {
  const error = new AppError('boom');
  assert.equal(error.name, 'AppError');
  assert.equal(error.message, 'boom');
  assert.equal(error.code, 'INTERNAL_ERROR');
  assert.equal(error.statusCode, 500);
  assert.equal(error.details, undefined);
  assert.ok(error instanceof Error);
});

test('AppError preserves explicit code/status/details', () => {
  const error = new AppError('nope', { code: 'BAD', statusCode: 400, details: { field: 'x' } });
  assert.equal(error.code, 'BAD');
  assert.equal(error.statusCode, 400);
  assert.deepEqual(error.details, { field: 'x' });
});

// ---------------------------------------------------------------------------
// normalizeProjectPath
// ---------------------------------------------------------------------------
test('normalizeProjectPath returns empty string for non-string or blank input', () => {
  assert.equal(normalizeProjectPath(undefined as never), '');
  assert.equal(normalizeProjectPath(null as never), '');
  assert.equal(normalizeProjectPath(123 as never), '');
  assert.equal(normalizeProjectPath('   '), '');
});

test('normalizeProjectPath trims whitespace and trailing separators', () => {
  assert.equal(normalizeProjectPath('  /home/user/project/  '), '/home/user/project');
  assert.equal(normalizeProjectPath('/home/user/project'), '/home/user/project');
});

test('normalizeProjectPath collapses dot segments', () => {
  assert.equal(normalizeProjectPath('/home/user/./project'), '/home/user/project');
  assert.equal(normalizeProjectPath('/home/user/sub/../project'), '/home/user/project');
});

test('normalizeProjectPath preserves the filesystem root', () => {
  assert.equal(normalizeProjectPath('/'), '/');
});

test('normalizeProjectPath handles Windows drive paths and long-path prefixes', () => {
  assert.equal(normalizeProjectPath('C:\\Users\\me\\project\\'), 'C:\\Users\\me\\project');
  // \\?\ long-path prefix is stripped before normalization.
  assert.equal(normalizeProjectPath('\\\\?\\C:\\Users\\me'), 'C:\\Users\\me');
});

// ---------------------------------------------------------------------------
// getPathBasename
// ---------------------------------------------------------------------------
test('getPathBasename splits on both separators regardless of host platform', () => {
  assert.equal(getPathBasename('/home/me/project'), 'project');
  assert.equal(getPathBasename('C:\\Users\\me\\project'), 'project');
  assert.equal(getPathBasename('\\\\wsl$\\Ubuntu\\home\\me\\project'), 'project');
});

test('getPathBasename ignores trailing separators and handles roots', () => {
  assert.equal(getPathBasename('/home/me/project/'), 'project');
  assert.equal(getPathBasename('C:\\Users\\me\\project\\'), 'project');
  assert.equal(getPathBasename('/'), '');
});

// ---------------------------------------------------------------------------
// translateWindowsPathForPosix
// ---------------------------------------------------------------------------
const withWslDistribution = (distributionName: string | undefined, run: () => void): void => {
  const previous = process.env.WSL_DISTRO_NAME;
  if (distributionName === undefined) {
    delete process.env.WSL_DISTRO_NAME;
  } else {
    process.env.WSL_DISTRO_NAME = distributionName;
  }

  try {
    run();
  } finally {
    if (previous === undefined) {
      delete process.env.WSL_DISTRO_NAME;
    } else {
      process.env.WSL_DISTRO_NAME = previous;
    }
  }
};

test('translateWindowsPathForPosix leaves POSIX paths untouched', () => {
  assert.deepEqual(translateWindowsPathForPosix('/home/me/project'), {
    path: '/home/me/project',
  });
});

test('translateWindowsPathForPosix maps a WSL UNC path onto the distro filesystem', () => {
  withWslDistribution('Ubuntu', () => {
    // Both spellings of the share address the same distro root.
    assert.deepEqual(
      translateWindowsPathForPosix('\\\\wsl$\\Ubuntu\\home\\me\\project'),
      { path: '/home/me/project' },
    );
    assert.deepEqual(
      translateWindowsPathForPosix('\\\\wsl.localhost\\Ubuntu\\home\\me\\project'),
      { path: '/home/me/project' },
    );
  });
});

test('translateWindowsPathForPosix rejects a UNC path for a different distribution', () => {
  withWslDistribution('Ubuntu', () => {
    const result = translateWindowsPathForPosix('\\\\wsl$\\Debian\\home\\me\\project');
    assert.equal(result.path, undefined);
    assert.match(result.error ?? '', /Debian/);
  });
});

test('translateWindowsPathForPosix never returns a Windows-shaped path on POSIX', () => {
  // The regression under test: path.resolve() on POSIX silently turns an
  // absolute Windows path into a relative one under process.cwd(). Whatever
  // the environment, the caller must never receive backslashes back.
  if (process.platform === 'win32') {
    return;
  }

  for (const windowsPath of [
    'C:\\Users\\me\\project',
    '\\\\some-server\\share\\project',
    '\\\\wsl$\\Ubuntu\\home\\me\\project',
  ]) {
    const result = translateWindowsPathForPosix(windowsPath);
    assert.ok(
      result.error !== undefined || !(result.path ?? '').includes('\\'),
      `expected an error or a backslash-free path for ${windowsPath}, got ${JSON.stringify(result)}`,
    );
  }
});

// ---------------------------------------------------------------------------
// toWindowsUncPathForWsl
// ---------------------------------------------------------------------------
test('toWindowsUncPathForWsl renders a distro path as a UNC share', () => {
  withWslDistribution('Ubuntu', () => {
    assert.equal(
      toWindowsUncPathForWsl('/home/me/project'),
      '\\\\wsl.localhost\\Ubuntu\\home\\me\\project',
    );
  });
});

test('toWindowsUncPathForWsl maps /mnt/<drive> back to a drive letter', () => {
  withWslDistribution('Ubuntu', () => {
    assert.equal(toWindowsUncPathForWsl('/mnt/c/Users/me'), 'C:\\Users\\me');
    assert.equal(toWindowsUncPathForWsl('/mnt/c'), 'C:\\');
  });
});

test('toWindowsUncPathForWsl returns null when there is no Windows equivalent', () => {
  withWslDistribution(undefined, () => {
    assert.equal(toWindowsUncPathForWsl('/home/me/project'), null);
  });

  withWslDistribution('Ubuntu', () => {
    assert.equal(toWindowsUncPathForWsl('relative/path'), null);
  });
});

test('toWindowsUncPathForWsl round-trips through translateWindowsPathForPosix', () => {
  // On Windows the translation is a no-op, so the round trip is POSIX-only.
  if (process.platform === 'win32') {
    return;
  }

  withWslDistribution('Ubuntu', () => {
    const windowsPath = toWindowsUncPathForWsl('/home/me/project');
    assert.ok(windowsPath);
    assert.deepEqual(translateWindowsPathForPosix(windowsPath), { path: '/home/me/project' });
  });
});

// ---------------------------------------------------------------------------
// generateMessageId
// ---------------------------------------------------------------------------
test('generateMessageId uses the default prefix and a uuid suffix', () => {
  const id = generateMessageId();
  assert.match(id, /^msg_[0-9a-f-]{36}$/);
});

test('generateMessageId honors a custom prefix and yields unique ids', () => {
  const a = generateMessageId('evt');
  const b = generateMessageId('evt');
  assert.match(a, /^evt_/);
  assert.notEqual(a, b);
});

// ---------------------------------------------------------------------------
// createNormalizedMessage
// ---------------------------------------------------------------------------
test('createNormalizedMessage fills missing envelope fields', () => {
  const message = createNormalizedMessage({ kind: 'text', provider: 'claude' });
  assert.equal(message.provider, 'claude');
  assert.equal(message.kind, 'text');
  assert.equal(message.sessionId, '');
  assert.match(message.id as string, /^text_/);
  assert.ok(!Number.isNaN(new Date(message.timestamp as string).getTime()));
});

test('createNormalizedMessage preserves provided id/sessionId/timestamp and extra fields', () => {
  const message = createNormalizedMessage({
    kind: 'text',
    provider: 'claude',
    id: 'fixed-id',
    sessionId: 'sess-1',
    timestamp: '2020-01-01T00:00:00.000Z',
    text: 'hello',
  });
  assert.equal(message.id, 'fixed-id');
  assert.equal(message.sessionId, 'sess-1');
  assert.equal(message.timestamp, '2020-01-01T00:00:00.000Z');
  assert.equal((message as Record<string, unknown>).text, 'hello');
});

// ---------------------------------------------------------------------------
// createCompleteMessage
// ---------------------------------------------------------------------------
test('createCompleteMessage marks a clean exit as success', () => {
  const message = createCompleteMessage({ provider: 'claude', sessionId: 's1', exitCode: 0 });
  assert.equal(message.kind, 'complete');
  assert.equal((message as Record<string, unknown>).success, true);
  assert.equal((message as Record<string, unknown>).aborted, false);
  assert.equal((message as Record<string, unknown>).actualSessionId, 's1');
});

test('createCompleteMessage treats a missing exit code as failure', () => {
  const message = createCompleteMessage({ provider: 'claude', sessionId: 's1' });
  assert.equal((message as Record<string, unknown>).exitCode, 1);
  assert.equal((message as Record<string, unknown>).success, false);
});

test('createCompleteMessage reports aborted runs as not successful even on exit 0', () => {
  const message = createCompleteMessage({ provider: 'claude', sessionId: 's1', exitCode: 0, aborted: true });
  assert.equal((message as Record<string, unknown>).aborted, true);
  assert.equal((message as Record<string, unknown>).success, false);
});

test('createCompleteMessage falls back to sessionId for actualSessionId', () => {
  const message = createCompleteMessage({ provider: 'claude', sessionId: 's1', actualSessionId: 's2', exitCode: 0 });
  assert.equal((message as Record<string, unknown>).actualSessionId, 's2');
  const noActual = createCompleteMessage({ provider: 'claude', sessionId: 's1', exitCode: 0 });
  assert.equal((noActual as Record<string, unknown>).actualSessionId, 's1');
});

// ---------------------------------------------------------------------------
// readObjectRecord
// ---------------------------------------------------------------------------
test('readObjectRecord accepts plain objects and rejects arrays/null/primitives', () => {
  assert.deepEqual(readObjectRecord({ a: 1 }), { a: 1 });
  assert.equal(readObjectRecord([1, 2]), null);
  assert.equal(readObjectRecord(null), null);
  assert.equal(readObjectRecord('str'), null);
  assert.equal(readObjectRecord(42), null);
  assert.equal(readObjectRecord(undefined), null);
});

// ---------------------------------------------------------------------------
// readOptionalString
// ---------------------------------------------------------------------------
test('readOptionalString normalizes empty/whitespace/non-string to undefined', () => {
  assert.equal(readOptionalString('hello'), 'hello');
  assert.equal(readOptionalString('  spaced  '), 'spaced');
  assert.equal(readOptionalString(''), undefined);
  assert.equal(readOptionalString('   '), undefined);
  assert.equal(readOptionalString(5 as never), undefined);
  assert.equal(readOptionalString(null as never), undefined);
});

// ---------------------------------------------------------------------------
// readStringArray
// ---------------------------------------------------------------------------
test('readStringArray keeps only string members and rejects non-arrays', () => {
  assert.deepEqual(readStringArray(['a', 1, 'b', null, 'c']), ['a', 'b', 'c']);
  assert.deepEqual(readStringArray([]), []);
  assert.equal(readStringArray('a'), undefined);
  assert.equal(readStringArray({ 0: 'a' }), undefined);
});

// ---------------------------------------------------------------------------
// readStringRecord
// ---------------------------------------------------------------------------
test('readStringRecord keeps string values and drops the rest', () => {
  assert.deepEqual(readStringRecord({ a: '1', b: 2, c: 'three' }), { a: '1', c: 'three' });
});

test('readStringRecord returns undefined when nothing usable remains', () => {
  assert.equal(readStringRecord({ a: 1, b: true }), undefined);
  assert.equal(readStringRecord([]), undefined);
  assert.equal(readStringRecord(null), undefined);
});

// ---------------------------------------------------------------------------
// buildDefaultProviderCurrentActiveModel
// ---------------------------------------------------------------------------
test('buildDefaultProviderCurrentActiveModel echoes the catalog default', () => {
  const result = buildDefaultProviderCurrentActiveModel({ OPTIONS: [], DEFAULT: 'sonnet' });
  assert.deepEqual(result, { model: 'sonnet' });
});

// ---------------------------------------------------------------------------
// parseIncomingJsonObject
// ---------------------------------------------------------------------------
test('parseIncomingJsonObject parses a JSON object string', () => {
  assert.deepEqual(parseIncomingJsonObject('{"type":"ping"}'), { type: 'ping' });
});

test('parseIncomingJsonObject parses Buffer and ArrayBuffer payloads', () => {
  assert.deepEqual(parseIncomingJsonObject(Buffer.from('{"a":1}', 'utf8')), { a: 1 });
  const arrayBuffer = new TextEncoder().encode('{"b":2}').buffer;
  assert.deepEqual(parseIncomingJsonObject(arrayBuffer), { b: 2 });
});

test('parseIncomingJsonObject concatenates a chunk array (Buffer + typed array)', () => {
  const chunks = [Buffer.from('{"a"', 'utf8'), new TextEncoder().encode(':3}')];
  assert.deepEqual(parseIncomingJsonObject(chunks), { a: 3 });
});

test('parseIncomingJsonObject returns null for blank, invalid, primitive, or array JSON', () => {
  assert.equal(parseIncomingJsonObject(''), null);
  assert.equal(parseIncomingJsonObject('   '), null);
  assert.equal(parseIncomingJsonObject('not json'), null);
  assert.equal(parseIncomingJsonObject('123'), null);
  assert.equal(parseIncomingJsonObject('[1,2]'), null);
  assert.equal(parseIncomingJsonObject(42), null);
});

// ---------------------------------------------------------------------------
// readJsonRecord
// ---------------------------------------------------------------------------
test('readJsonRecord parses JSON strings into records', () => {
  assert.deepEqual(readJsonRecord('{"x":1}'), { x: 1 });
});

test('readJsonRecord narrows existing objects and rejects arrays/invalid', () => {
  assert.deepEqual(readJsonRecord({ y: 2 }), { y: 2 });
  assert.equal(readJsonRecord('[1,2]'), null);
  assert.equal(readJsonRecord('nope'), null);
  assert.equal(readJsonRecord([1]), null);
});

// ---------------------------------------------------------------------------
// normalizeProviderTimestamp
// ---------------------------------------------------------------------------
test('normalizeProviderTimestamp converts epoch seconds and millis', () => {
  // Seconds (< 1e12) get multiplied by 1000.
  assert.equal(normalizeProviderTimestamp(1_600_000_000), '2020-09-13T12:26:40.000Z');
  // Milliseconds pass through.
  assert.equal(normalizeProviderTimestamp(1_600_000_000_000), '2020-09-13T12:26:40.000Z');
});

test('normalizeProviderTimestamp parses numeric strings and ISO date strings', () => {
  assert.equal(normalizeProviderTimestamp('1600000000'), '2020-09-13T12:26:40.000Z');
  assert.equal(normalizeProviderTimestamp('2021-06-01T10:00:00.000Z'), '2021-06-01T10:00:00.000Z');
});

test('normalizeProviderTimestamp falls back to now for invalid input', () => {
  const before = Date.now();
  const result = normalizeProviderTimestamp('not-a-date');
  const parsed = new Date(result).getTime();
  assert.ok(parsed >= before - 1000 && parsed <= Date.now() + 1000);
  // Zero/negative/NaN numbers are not treated as valid epochs.
  assert.ok(!Number.isNaN(new Date(normalizeProviderTimestamp(0)).getTime()));
});

// ---------------------------------------------------------------------------
// normalizeSessionName
// ---------------------------------------------------------------------------
test('normalizeSessionName collapses whitespace and trims', () => {
  assert.equal(normalizeSessionName('  hello   world  ', 'fallback'), 'hello world');
});

test('normalizeSessionName returns the fallback for empty/undefined input', () => {
  assert.equal(normalizeSessionName('', 'fallback'), 'fallback');
  assert.equal(normalizeSessionName('    ', 'fallback'), 'fallback');
  assert.equal(normalizeSessionName(undefined, 'fallback'), 'fallback');
});

test('normalizeSessionName truncates to 120 characters', () => {
  const long = 'a'.repeat(200);
  assert.equal(normalizeSessionName(long, 'fallback').length, 120);
});

// ---------------------------------------------------------------------------
// sanitizeLeafDirectoryName
// ---------------------------------------------------------------------------
test('sanitizeLeafDirectoryName returns a trimmed valid leaf name', () => {
  assert.equal(sanitizeLeafDirectoryName('  session-123  '), 'session-123');
});

test('sanitizeLeafDirectoryName rejects empty input', () => {
  assert.throws(() => sanitizeLeafDirectoryName('   '), /directory name is required/i);
  assert.throws(() => sanitizeLeafDirectoryName('   ', 'session id'), /session id is required/i);
});

test('sanitizeLeafDirectoryName blocks traversal and nested paths', () => {
  assert.throws(() => sanitizeLeafDirectoryName('..'), /Invalid directory name/);
  assert.throws(() => sanitizeLeafDirectoryName('a/b'), /Invalid directory name/);
  assert.throws(() => sanitizeLeafDirectoryName('a\\b'), /Invalid directory name/);
  assert.throws(() => sanitizeLeafDirectoryName('../secret', 'session id'), /Invalid session id/);
});

// ---------------------------------------------------------------------------
// addUniqueProviderSkillSource
// ---------------------------------------------------------------------------
test('addUniqueProviderSkillSource dedupes by resolved rootDir', () => {
  const sources: ProviderSkillSource[] = [];
  const seen = new Set<string>();
  const base = os.tmpdir();

  addUniqueProviderSkillSource(sources, seen, { scope: 'user', rootDir: path.join(base, 'skills') });
  // Same directory expressed with a dot segment resolves to the same root.
  addUniqueProviderSkillSource(sources, seen, { scope: 'user', rootDir: path.join(base, 'skills', '.') });
  addUniqueProviderSkillSource(sources, seen, { scope: 'project', rootDir: path.join(base, 'other') });

  assert.equal(sources.length, 2);
  assert.equal(sources[0].rootDir, path.resolve(path.join(base, 'skills')));
  assert.equal(sources[1].rootDir, path.resolve(path.join(base, 'other')));
});

// ---------------------------------------------------------------------------
// readProviderSkillMarkdownDefinitionFromContent
// ---------------------------------------------------------------------------
test('readProviderSkillMarkdownDefinitionFromContent reads name/description from front matter', () => {
  const content = '---\nname: my-skill\ndescription: Does a thing\n---\n\nBody.\n';
  assert.deepEqual(readProviderSkillMarkdownDefinitionFromContent(content, 'fallback'), {
    name: 'my-skill',
    description: 'Does a thing',
  });
});

test('readProviderSkillMarkdownDefinitionFromContent uses the fallback name and empty description', () => {
  const content = '---\ndescription: only desc\n---\n\nBody.\n';
  assert.deepEqual(readProviderSkillMarkdownDefinitionFromContent(content, 'dir-name'), {
    name: 'dir-name',
    description: 'only desc',
  });

  assert.deepEqual(readProviderSkillMarkdownDefinitionFromContent('no front matter', 'dir-name'), {
    name: 'dir-name',
    description: '',
  });
});

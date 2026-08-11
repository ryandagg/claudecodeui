import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { readFirstUserMessagePreview } from '@/modules/providers/services/session-preview.service.js';

const makeTempDir = () => fs.mkdtemp(path.join(os.tmpdir(), 'cg-preview-'));

async function writeTranscript(lines: unknown[]): Promise<string> {
  const dir = await makeTempDir();
  const filePath = path.join(dir, 'session.jsonl');
  await fs.writeFile(filePath, lines.map((line) => JSON.stringify(line)).join('\n') + '\n', 'utf8');
  return filePath;
}

const userTextMessage = (text: string) => ({
  type: 'user',
  message: { role: 'user', content: [{ type: 'text', text }] },
});

test('reads the first real user message past non-message preamble', async () => {
  const filePath = await writeTranscript([
    { type: 'queue-operation', op: 'enqueue' },
    { type: 'queue-operation', op: 'dequeue' },
    { type: 'attachment', name: 'foo.txt' },
    userTextMessage('Can you investigate the failing search query?'),
    userTextMessage('a later prompt that must not win'),
  ]);

  assert.equal(
    await readFirstUserMessagePreview(filePath),
    'Can you investigate the failing search query?',
  );
});

test('collapses whitespace and truncates to the preview limit', async () => {
  const longText = 'word '.repeat(40); // 200 chars, whitespace-heavy
  const filePath = await writeTranscript([userTextMessage(longText)]);

  const preview = await readFirstUserMessagePreview(filePath);
  assert.equal(preview.length, 80);
  assert.equal(preview, ('word '.repeat(40)).replace(/\s+/g, ' ').trim().slice(0, 80));
  assert.ok(!preview.includes('  '), 'runs of whitespace should be collapsed');
});

test('ignores assistant messages and returns empty when no user prompt exists', async () => {
  const filePath = await writeTranscript([
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'hello from the model' }] } },
    { type: 'ai-title', aiTitle: 'Some Title' },
  ]);

  assert.equal(await readFirstUserMessagePreview(filePath), '');
});

test('returns empty for a slash-command-only opener (no searchable user text)', async () => {
  // Local-command wrappers with no command name/args yield no user text.
  const filePath = await writeTranscript([
    { type: 'user', message: { role: 'user', content: '<local-command-stdout></local-command-stdout>' } },
  ]);

  assert.equal(await readFirstUserMessagePreview(filePath), '');
});

test('surfaces the command a user ran as the preview', async () => {
  const filePath = await writeTranscript([
    {
      type: 'user',
      message: {
        role: 'user',
        content: '<command-name>/model</command-name><command-args>opus</command-args>',
      },
    },
  ]);

  assert.equal(await readFirstUserMessagePreview(filePath), '/model opus');
});

test('skips meta/system-injected content before the first genuine prompt', async () => {
  const filePath = await writeTranscript([
    { type: 'user', isMeta: true, message: { role: 'user', content: 'internal bookkeeping' } },
    { type: 'user', message: { role: 'user', content: '<system-reminder>context</system-reminder>' } },
    userTextMessage('the actual first question'),
  ]);

  assert.equal(await readFirstUserMessagePreview(filePath), 'the actual first question');
});

test('returns empty for a missing file rather than throwing', async () => {
  const dir = await makeTempDir();
  assert.equal(await readFirstUserMessagePreview(path.join(dir, 'nope.jsonl')), '');
});

test('tolerates malformed JSONL lines mid-stream', async () => {
  const dir = await makeTempDir();
  const filePath = path.join(dir, 'session.jsonl');
  await fs.writeFile(
    filePath,
    ['{ this is not json', JSON.stringify(userTextMessage('recovered prompt'))].join('\n') + '\n',
    'utf8',
  );

  assert.equal(await readFirstUserMessagePreview(filePath), 'recovered prompt');
});

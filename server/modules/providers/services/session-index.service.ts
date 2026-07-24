import fs from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';

import { searchIndexDb, sessionsDb } from '@/modules/database/index.js';
import type { IndexableMessage } from '@/modules/database/index.js';
import { extractClaudeSearchableMessage } from '@/modules/providers/services/claude-transcript-text.service.js';

/**
 * Number of files to index before yielding the event loop during backfill.
 * better-sqlite3 writes are synchronous, so backfilling the whole corpus in one
 * tight loop would block request handling for several seconds. Yielding keeps
 * the server responsive while the (one-time) backfill runs in the background.
 */
const BACKFILL_YIELD_EVERY = 20;

/**
 * Resolves a transcript path to the canonical form stored in the index, so the
 * indexer (write side) and the search query (read side) always agree on the
 * key regardless of how the raw path was captured.
 */
export function normalizeIndexPath(jsonlPath: string): string {
  return path.resolve(jsonlPath);
}

function isSubagentTranscript(jsonlPath: string): boolean {
  return path.normalize(jsonlPath).split(path.sep).includes('subagents');
}

type ParsedRange = {
  messages: IndexableMessage[];
  /** Bytes from the start of the read window that form complete (newline-terminated) lines. */
  completeBytes: number;
};

/**
 * Reads a byte window `[startByte, endByte)` of a JSONL transcript and returns
 * the indexable messages from its complete lines only.
 *
 * A trailing line with no newline (a transcript mid-append) is intentionally
 * left unprocessed and NOT counted in `completeBytes`, so the caller advances
 * the cursor only past fully-written lines and re-reads the remainder next
 * time. Splitting on the raw `\n` byte is UTF-8 safe: 0x0A never appears inside
 * a multi-byte sequence.
 */
async function parseByteRange(
  jsonlPath: string,
  startByte: number,
  endByte: number,
  seqBase: number,
): Promise<ParsedRange> {
  const messages: IndexableMessage[] = [];
  if (endByte <= startByte) {
    return { messages, completeBytes: 0 };
  }

  const stream = fs.createReadStream(jsonlPath, { start: startByte, end: endByte - 1 });
  const decoder = new StringDecoder('utf8');
  let pending = '';
  // Bytes belonging to complete (newline-terminated) lines already emitted.
  let completeBytes = 0;
  let seq = seqBase;

  const processLine = (lineText: string): void => {
    const trimmed = lineText.trim();
    if (!trimmed) {
      return;
    }
    let entry: Record<string, any>;
    try {
      entry = JSON.parse(trimmed);
    } catch {
      return;
    }
    const searchable = extractClaudeSearchableMessage(entry);
    if (!searchable) {
      return;
    }
    messages.push({
      role: searchable.role,
      text: searchable.text,
      timestamp: typeof entry.timestamp === 'string' ? entry.timestamp : null,
      messageUuid: typeof entry.uuid === 'string' ? entry.uuid : null,
      seq: seq++,
    });
  };

  for await (const chunk of stream) {
    pending += decoder.write(chunk as Buffer);
    let newlineIndex = pending.indexOf('\n');
    while (newlineIndex !== -1) {
      const line = pending.slice(0, newlineIndex);
      processLine(line);
      // Advance the complete-byte counter by the UTF-8 byte length of the line
      // plus its newline, so the cursor lands exactly on a line boundary even
      // when the transcript contains multi-byte characters.
      completeBytes += Buffer.byteLength(line, 'utf8') + 1;
      pending = pending.slice(newlineIndex + 1);
      newlineIndex = pending.indexOf('\n');
    }
  }

  // Any bytes still buffered in the decoder are an incomplete trailing
  // multi-byte sequence; they belong to the not-yet-complete final line and are
  // intentionally excluded from completeBytes.
  return { messages, completeBytes };
}

/**
 * Indexes a single transcript file, reading only the bytes appended since the
 * last run.
 *
 * - No cursor yet, or the file shrank/was rewritten (current size below the
 *   recorded size) → full re-index from byte 0 via `replaceFileMessages`.
 * - File unchanged (size equals the indexed byte count) → no-op.
 * - File grew → parse only the appended window and `appendFileMessages`.
 *
 * Subagent transcripts and missing files are skipped.
 */
export async function indexFileIncrementally(
  jsonlPath: string,
  projectPath: string | null,
): Promise<void> {
  if (!jsonlPath || !jsonlPath.endsWith('.jsonl') || isSubagentTranscript(jsonlPath)) {
    return;
  }

  const normalizedPath = normalizeIndexPath(jsonlPath);

  let fileSize: number;
  try {
    const stats = await stat(normalizedPath);
    if (!stats.isFile()) {
      return;
    }
    fileSize = stats.size;
  } catch {
    // File vanished between discovery and indexing — nothing to do.
    return;
  }

  const cursor = searchIndexDb.getFileCursor(normalizedPath);
  const needsFullReindex = cursor === null || fileSize < cursor.file_size;

  if (!needsFullReindex && fileSize === cursor.indexed_bytes) {
    return;
  }

  if (needsFullReindex) {
    // completeBytes may be < fileSize when the file ends mid-line (an in-flight
    // append); store only the fully-parsed byte extent so the trailing partial
    // line is re-read on the next pass rather than skipped.
    const { messages, completeBytes } = await parseByteRange(normalizedPath, 0, fileSize, 0);
    searchIndexDb.replaceFileMessages(normalizedPath, projectPath, messages, completeBytes, fileSize);
    return;
  }

  const startByte = cursor.indexed_bytes;
  const { messages, completeBytes } = await parseByteRange(normalizedPath, startByte, fileSize, 0);
  const indexedBytes = startByte + completeBytes;
  searchIndexDb.appendFileMessages(normalizedPath, projectPath, messages, indexedBytes, fileSize);
}

/**
 * Indexes every known session transcript. Idempotent and cheap on restart:
 * files whose recorded size still matches are skipped by
 * `indexFileIncrementally`. Yields the event loop periodically so the one-time
 * cold backfill does not block request handling.
 */
export async function backfillAll(
  onProgress?: (indexed: number, total: number) => void,
): Promise<{ indexedFiles: number }> {
  const sessions = sessionsDb.getAllSessions();
  const seen = new Set<string>();
  let processed = 0;

  for (const session of sessions) {
    const rawPath = typeof session.jsonl_path === 'string' ? session.jsonl_path.trim() : '';
    if (!rawPath) {
      continue;
    }
    const normalizedPath = normalizeIndexPath(rawPath);
    if (seen.has(normalizedPath)) {
      continue;
    }
    seen.add(normalizedPath);

    try {
      await indexFileIncrementally(normalizedPath, session.project_path ?? null);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('Session index backfill failed for file', { jsonlPath: normalizedPath, error: message });
    }

    processed += 1;
    if (onProgress) {
      onProgress(processed, seen.size);
    }
    if (processed % BACKFILL_YIELD_EVERY === 0) {
      await new Promise((resolve) => setImmediate(resolve));
    }
  }

  return { indexedFiles: seen.size };
}

export const sessionIndexService = {
  indexFileIncrementally,
  backfillAll,
  normalizeIndexPath,
};

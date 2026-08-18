import fs from 'node:fs';
import readline from 'node:readline';

import { extractClaudeSearchableMessage } from '@/modules/providers/services/claude-transcript-text.service.js';

/**
 * Longest preview we surface as a sidebar label. Long enough to be recognisable,
 * short enough that one prompt never dominates the list row.
 */
const MAX_PREVIEW_LENGTH = 80;

/**
 * Upper bound on lines scanned before giving up. The first genuine user message
 * is normally within the first handful of lines (identity, queue-operation and
 * attachment rows precede it), so this only guards against a pathological file
 * whose opening is all non-message traffic — it must never scan a whole
 * multi-megabyte transcript just to build a label.
 */
const MAX_PREVIEW_SCAN_LINES = 200;

/**
 * Derives a display-only label from the first real user message of a transcript.
 *
 * This is the render-time fallback for a session with no cached title (no
 * `custom-title`/`ai-title` on disk). Nothing here is persisted: a preview is
 * recomputed on each list read, so it can never flip-flop the way a stored
 * fabricated name did.
 *
 * Only the head of the file is read — the scan stops at the first message that
 * `extractClaudeSearchableMessage` accepts as a user message, which already
 * skips meta rows, harness-injected content, and empty local-command wrappers.
 * A transcript that opens with nothing user-typed (only a `/command`, an image,
 * or system traffic) yields an empty string, and the caller falls back to the
 * generic "New Session" label.
 */
export async function readFirstUserMessagePreview(filePath: string): Promise<string> {
  let lineReader: readline.Interface | undefined;

  try {
    const fileStream = fs.createReadStream(filePath);
    lineReader = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

    let scanned = 0;
    for await (const line of lineReader) {
      if (scanned >= MAX_PREVIEW_SCAN_LINES) {
        break;
      }
      scanned += 1;

      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }

      let entry: Record<string, unknown>;
      try {
        entry = JSON.parse(trimmed) as Record<string, unknown>;
      } catch {
        // Partially written or malformed lines are expected while a session streams.
        continue;
      }

      // Mirror the transcript UI, which hides `isMeta` rows from the visible
      // conversation. `extractClaudeSearchableMessage` keeps them because the
      // search index intentionally covers more than the label should, so the
      // preview filters them here rather than widening the shared extractor.
      if (entry.isMeta === true) {
        continue;
      }

      const message = extractClaudeSearchableMessage(entry);
      if (message?.role === 'user') {
        const normalized = message.text.replace(/\s+/g, ' ').trim();
        if (normalized) {
          return normalized.slice(0, MAX_PREVIEW_LENGTH);
        }
      }
    }
  } catch {
    // No transcript on disk, or an unreadable one: no preview, generic fallback.
    return '';
  } finally {
    lineReader?.close();
  }

  return '';
}

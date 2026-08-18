import path from 'node:path';

import { sessionsDb } from '@/modules/database/index.js';
import {
  getClaudeHome,
  findFilesRecursivelyModifiedAfter,
  normalizeSessionName,
  readFileTimestamps,
  readSessionTranscriptFacts,
} from '@/shared/utils.js';
import type { IProviderSessionSynchronizer } from '@/shared/interfaces.js';

type ParsedSession = {
  sessionId: string;
  projectPath: string;
  sessionName?: string;
  createdAt?: string;
  updatedAt?: string;
};

/**
 * Session indexer for Claude transcript artifacts.
 */
export class ClaudeSessionSynchronizer implements IProviderSessionSynchronizer {
  private readonly provider = 'claude' as const;
  private get claudeHome(): string { return getClaudeHome(); }

  /**
   * Returns true when a JSONL file is a subagent transcript rather than a
   * top-level session.
   *
   * Claude stores subagent transcripts under a `subagents/` directory, e.g.
   * `~/.claude/projects/<encoded-cwd>/<session-id>/subagents/agent-<id>.jsonl`.
   * Those files repeat the parent session's `sessionId`, so indexing them as
   * standalone sessions overwrites the parent row's `jsonl_path` and corrupts
   * the main session record. The recursive scan in `synchronize()` reaches
   * them, so both entry points must skip them.
   */
  private isSubagentTranscript(filePath: string): boolean {
    return path.normalize(filePath).split(path.sep).includes('subagents');
  }

  /**
   * Scans ~/.claude/projects and upserts discovered sessions into DB.
   */
  async synchronize(since?: Date): Promise<number> {
    const files = await findFilesRecursivelyModifiedAfter(
      path.join(this.claudeHome, 'projects'),
      '.jsonl',
      since ?? null
    );

    let processed = 0;
    for (const filePath of files) {
      if (this.isSubagentTranscript(filePath)) {
        continue;
      }

      const parsed = await this.processSessionFile(filePath);
      if (!parsed) {
        continue;
      }

      const timestamps = parsed.createdAt || parsed.updatedAt
        ? { createdAt: parsed.createdAt, updatedAt: parsed.updatedAt }
        : await readFileTimestamps(filePath);
      sessionsDb.createSession(
        parsed.sessionId,
        this.provider,
        parsed.projectPath,
        parsed.sessionName,
        timestamps.createdAt,
        timestamps.updatedAt,
        filePath
      );
      processed += 1;
    }

    return processed;
  }

  /**
   * Parses and upserts one Claude session JSONL file.
   */
  async synchronizeFile(filePath: string): Promise<string | null> {
    if (!filePath.endsWith('.jsonl')) {
      return null;
    }
    if (this.isSubagentTranscript(filePath)) {
      return null;
    }

    const parsed = await this.processSessionFile(filePath);
    if (!parsed) {
      return null;
    }

    const timestamps = parsed.createdAt || parsed.updatedAt
      ? { createdAt: parsed.createdAt, updatedAt: parsed.updatedAt }
      : await readFileTimestamps(filePath);
    return sessionsDb.createSession(
      parsed.sessionId,
      this.provider,
      parsed.projectPath,
      parsed.sessionName,
      timestamps.createdAt,
      timestamps.updatedAt,
      filePath
    );
  }

  /**
   * Extracts session metadata from one Claude JSONL session file.
   */
  private async processSessionFile(
    filePath: string
  ): Promise<ParsedSession | null> {
    // One pass for identity, title and activity span. The watcher fires on
    // every append to an active transcript, so scanning once per fact would
    // re-read a growing multi-megabyte file several times per change.
    const facts = await readSessionTranscriptFacts(filePath);
    if (!facts.sessionId || !facts.projectPath) {
      return null;
    }

    // Only a real transcript title is cached as the session name: a user's
    // `/rename` (`custom-title`) or Claude's own `ai-title`. Both live in the
    // transcript, so the cached value always matches what `claude --resume`
    // shows and can never disagree with it.
    //
    // Deliberately no fallback to history.jsonl's `display` or a static
    // placeholder. `display` is only the first prompt — literally "/model" or
    // "[Pasted text …]" for many sessions — so caching it fabricates a name
    // that is nowhere in the transcript and then flip-flops on every sync.
    // A session with no title stays unnamed here (provider_name NULL); the
    // sidebar derives a first-message preview at read time instead.
    const sessionName = facts.title
      ? normalizeSessionName(facts.title, '')
      : undefined;

    return {
      sessionId: facts.sessionId,
      projectPath: facts.projectPath,
      sessionName: sessionName || undefined,
      createdAt: facts.createdAt,
      updatedAt: facts.updatedAt,
    };
  }

}

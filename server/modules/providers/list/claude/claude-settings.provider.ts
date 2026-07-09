import os from 'os';
import path from 'path';

import {
  readJsonConfig,
  writeJsonConfig,
  readObjectRecord,
  readStringArray,
} from '../../../../shared/utils.js';

/**
 * Single source of truth for Claude's own permission config.
 *
 * The app deliberately does NOT keep its own permission store. Claude's CLI and
 * the Agent SDK both read `permissions.allow` / `permissions.deny` / `permissions.ask`
 * from the settings.json files named in `settingSources`, and the SDK enforces those
 * rules itself before our `canUseTool` callback ever runs. So the app only needs to
 * READ these files (to show the current rules) and WRITE them (to persist a grant) —
 * the exact same files the terminal `claude` uses.
 *
 * User scope: ~/.claude/settings.json
 */

export type ClaudePermissions = {
  allow: string[];
  deny: string[];
  ask: string[];
  defaultMode?: string;
};

function userSettingsPath(): string {
  return path.join(os.homedir(), '.claude', 'settings.json');
}

function extractPermissions(settings: Record<string, unknown>): ClaudePermissions {
  const permissions = readObjectRecord(settings.permissions) ?? {};
  return {
    allow: readStringArray(permissions.allow) ?? [],
    deny: readStringArray(permissions.deny) ?? [],
    ask: readStringArray(permissions.ask) ?? [],
    defaultMode: typeof permissions.defaultMode === 'string' ? permissions.defaultMode : undefined,
  };
}

/**
 * Reads the effective Claude permission rules from the user settings file.
 */
export async function readClaudePermissions(): Promise<ClaudePermissions> {
  const settings = await readJsonConfig(userSettingsPath());
  return extractPermissions(settings);
}

/**
 * Read-modify-write the user settings.json, replacing the permission lists while
 * preserving every other key (env, model, hooks, etc.) untouched.
 */
export async function writeClaudePermissions(next: {
  allow?: string[];
  deny?: string[];
  ask?: string[];
}): Promise<ClaudePermissions> {
  const filePath = userSettingsPath();
  const settings = await readJsonConfig(filePath);
  const permissions = readObjectRecord(settings.permissions) ?? {};

  const merged: Record<string, unknown> = { ...permissions };
  if (next.allow) merged.allow = dedupe(next.allow);
  if (next.deny) merged.deny = dedupe(next.deny);
  if (next.ask) merged.ask = dedupe(next.ask);

  settings.permissions = merged;
  await writeJsonConfig(filePath, settings);
  return extractPermissions(settings);
}

/**
 * Adds a single entry to `permissions.allow` (and removes it from `deny` if present),
 * the persistence path behind a "Allow & remember" decision. Idempotent.
 */
export async function addClaudeAllowRule(entry: string): Promise<ClaudePermissions> {
  const current = await readClaudePermissions();
  const allow = dedupe([...current.allow, entry]);
  const deny = current.deny.filter((rule) => rule !== entry);
  return writeClaudePermissions({ allow, deny });
}

function dedupe(items: string[]): string[] {
  return Array.from(new Set(items.map((item) => item.trim()).filter(Boolean)));
}

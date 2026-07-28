import os from 'os';
import path from 'path';

import {
  readJsonConfig,
  writeJsonConfig,
  readObjectRecord,
  readStringArray,
} from '../../../../shared/utils.js';

/**
 * Single source of truth for Claude's own permission config AND default model.
 *
 * The app deliberately does NOT keep its own permission store. Claude's CLI and
 * the Agent SDK both read `permissions.allow` / `permissions.deny` / `permissions.ask`
 * from the settings.json files named in `settingSources`, and the SDK enforces those
 * rules itself before our `canUseTool` callback ever runs. So the app only needs to
 * READ these files (to show the current rules) and WRITE them (to persist a grant) —
 * the exact same files the terminal `claude` uses.
 *
 * The default model differs in one way: it is READ-ONLY here. The Agent SDK reads the
 * top-level `model` key from these files when a `query()` runs without an explicit
 * model option, so the app treats `~/.claude/settings.json` as the single source for
 * the default model — no parallel SQLite store. But unlike permissions (which the app
 * persists on an explicit grant), the app never writes the model key: the terminal
 * `/model` owns that default, and a per-chat model choice is session state carried on
 * each send as options.model, not a write back to the shared file. Reverting the model
 * in the terminal therefore governs the app immediately, and the two can never silently
 * disagree — nor can a single chat rewrite the terminal-wide default.
 *
 * User scope: ~/.claude/settings.json
 */

/**
 * The SDK's "let Claude pick" sentinel. Storing it means the `model` key is absent
 * from settings.json entirely, so the SDK applies its own default.
 *
 * Declared here rather than alongside the model catalog because the catalog module
 * already imports from this one; putting it there would make the two circular.
 */
export const CLAUDE_DEFAULT_MODEL_VALUE = 'default';

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

/**
 * Reads the top-level `model` key verbatim from the user settings file.
 *
 * The value is returned verbatim. It is a model identifier in the SDK's own
 * vocabulary (e.g. `us.anthropic.claude-opus-4-8[1m]`), which is the same
 * vocabulary the model catalog is built from — so no translation is needed or
 * wanted here. `null` means the key is absent, i.e. "use the SDK/CLI default".
 */
export async function readClaudeModel(): Promise<string | null> {
  const settings = await readJsonConfig(userSettingsPath());
  return typeof settings.model === 'string' && settings.model.trim()
    ? settings.model.trim()
    : null;
}

function dedupe(items: string[]): string[] {
  return Array.from(new Set(items.map((item) => item.trim()).filter(Boolean)));
}

import { useCallback, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';

import { useSettings } from '../../../../contexts/SettingsContext';
import SettingsCard from '../SettingsCard';
import SettingsSection from '../SettingsSection';

/** DB-backed user setting holding the generic Claude env overrides as a JSON object string. */
export const SESSION_ENV_STORAGE_KEY = 'claude-session-env';

type EnvRow = { key: string; value: string };

/**
 * Parses the stored `claude-session-env` value (a JSON object string) into
 * ordered rows. Malformed JSON or a non-object yields no rows rather than
 * throwing — the editor stays usable and the next save overwrites the bad value.
 */
function parseEnvRows(raw: string | null): EnvRow[] {
  if (!raw || raw.trim().length === 0) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return [];
    return Object.entries(parsed).map(([key, value]) => ({
      key,
      value: typeof value === 'string' ? value : String(value),
    }));
  } catch {
    return [];
  }
}

/**
 * Serializes rows back to a JSON object string, keeping only rows with a
 * non-empty key. Later rows win on duplicate keys.
 */
function serializeEnvRows(rows: EnvRow[]): string {
  const obj: Record<string, string> = {};
  for (const { key, value } of rows) {
    const trimmedKey = key.trim();
    if (trimmedKey.length > 0) obj[trimmedKey] = value;
  }
  return JSON.stringify(obj);
}

export default function EnvironmentSettingsTab() {
  const { getSetting, setSetting } = useSettings();
  // Local row state (initialized from the stored setting) so keys can be edited
  // in place, including transient empty rows the JSON object can't represent.
  const [rows, setRows] = useState<EnvRow[]>(() => parseEnvRows(getSetting(SESSION_ENV_STORAGE_KEY)));

  const persist = useCallback((next: EnvRow[]) => {
    setRows(next);
    setSetting(SESSION_ENV_STORAGE_KEY, serializeEnvRows(next));
  }, [setSetting]);

  const handleAddRow = useCallback(() => {
    persist([...rows, { key: '', value: '' }]);
  }, [rows, persist]);

  const handleRemoveRow = useCallback((index: number) => {
    persist(rows.filter((_, i) => i !== index));
  }, [rows, persist]);

  const handleKeyChange = useCallback((index: number, key: string) => {
    persist(rows.map((row, i) => (i === index ? { ...row, key } : row)));
  }, [rows, persist]);

  const handleValueChange = useCallback((index: number, value: string) => {
    persist(rows.map((row, i) => (i === index ? { ...row, value } : row)));
  }, [rows, persist]);

  return (
    <div className="space-y-8">
      <SettingsSection
        title="Environment Variables"
        description="Key/value pairs applied to every Claude session via the settings.env layer (equivalent to the --settings CLI flag). Use this for keys Claude Code reads from settings rather than the process environment, e.g. CLAUDE_CODE_AUTO_COMPACT_WINDOW."
      >
        <SettingsCard>
          <div className="space-y-3 p-4">
            <div className="rounded-md border border-dashed border-muted-foreground/30 bg-muted/30 px-3 py-2">
              <p className="text-xs text-muted-foreground">
                Applies to all sessions. Changes take effect on the next message turn,
                not the current one.
              </p>
            </div>

            {rows.map((row, index) => (
              <div key={index} className="flex items-center gap-2">
                <input
                  type="text"
                  value={row.key}
                  onChange={(e) => handleKeyChange(index, e.target.value)}
                  placeholder="KEY"
                  className="w-2/5 rounded-md border border-input bg-muted/50 px-3 py-1.5 font-mono text-sm text-foreground outline-none placeholder:text-muted-foreground/50"
                  spellCheck={false}
                  autoComplete="off"
                  autoCapitalize="off"
                />
                <input
                  type="text"
                  value={row.value}
                  onChange={(e) => handleValueChange(index, e.target.value)}
                  placeholder="value"
                  className="flex-1 rounded-md border border-input bg-muted/50 px-3 py-1.5 font-mono text-sm text-foreground outline-none placeholder:text-muted-foreground/50"
                  spellCheck={false}
                  autoComplete="off"
                  autoCapitalize="off"
                />
                <button
                  onClick={() => handleRemoveRow(index)}
                  className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
                  aria-label="Remove variable"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}

            <button
              onClick={handleAddRow}
              className="flex items-center gap-1.5 rounded-md px-2 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <Plus className="h-4 w-4" />
              Add variable
            </button>
          </div>
        </SettingsCard>
      </SettingsSection>
    </div>
  );
}

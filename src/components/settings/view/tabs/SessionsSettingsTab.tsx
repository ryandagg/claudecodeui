import { useCallback, useEffect, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';

import SettingsCard from '../SettingsCard';
import SettingsSection from '../SettingsSection';
import {
  HIDDEN_SESSION_STORAGE_KEY,
  HIDE_WORKTREE_SESSIONS_KEY,
  getHiddenSessionPatterns,
  getHideWorktreeSessions,
  setHiddenSessionPatterns,
  setHideWorktreeSessions,
} from '../../../sidebar/utils/utils';

export default function SessionsSettingsTab() {
  const [hideWorktree, setHideWorktree] = useState(getHideWorktreeSessions);
  const [patterns, setPatterns] = useState<string[]>(getHiddenSessionPatterns);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === HIDDEN_SESSION_STORAGE_KEY) {
        setPatterns(getHiddenSessionPatterns());
      }
      if (e.key === HIDE_WORKTREE_SESSIONS_KEY) {
        setHideWorktree(getHideWorktreeSessions());
      }
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const persist = useCallback((next: string[]) => {
    setPatterns(next);
    setHiddenSessionPatterns(next);
  }, []);

  const handleAdd = useCallback(() => {
    const value = draft.trim();
    if (!value) return;
    try {
      new RegExp(value);
    } catch {
      setError('Invalid regex');
      return;
    }
    if (patterns.includes(value)) {
      setError('Pattern already exists');
      return;
    }
    setError(null);
    persist([...patterns, value]);
    setDraft('');
  }, [draft, patterns, persist]);

  const handleRemove = useCallback((index: number) => {
    persist(patterns.filter((_, i) => i !== index));
  }, [patterns, persist]);

  const handleEdit = useCallback((index: number, value: string) => {
    try {
      new RegExp(value);
    } catch {
      return;
    }
    const next = [...patterns];
    next[index] = value;
    persist(next);
  }, [patterns, persist]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleAdd();
    }
  }, [handleAdd]);

  const handleWorktreeToggle = useCallback(() => {
    const next = !hideWorktree;
    setHideWorktree(next);
    setHideWorktreeSessions(next);
  }, [hideWorktree]);

  return (
    <div className="space-y-8">
      <SettingsSection
        title="Subagent Sessions"
        description="Worktree-isolated agent sessions (created by the Agent tool) can clutter the sidebar."
      >
        <SettingsCard>
          <label className="flex cursor-pointer items-center justify-between p-4">
            <div>
              <p className="text-sm font-medium text-foreground">Hide worktree agent sessions</p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                Hides sessions whose project path contains a worktree directory
              </p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={hideWorktree}
              onClick={handleWorktreeToggle}
              className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${
                hideWorktree ? 'bg-primary' : 'bg-muted-foreground/30'
              }`}
            >
              <span
                className={`inline-block h-3.5 w-3.5 rounded-full bg-white shadow-sm transition-transform ${
                  hideWorktree ? 'translate-x-[18px]' : 'translate-x-[3px]'
                }`}
              />
            </button>
          </label>
        </SettingsCard>
      </SettingsSection>

      <SettingsSection
        title="Hidden Sessions"
        description="Sessions whose name matches any regex pattern below will be hidden from the sidebar."
      >
        <SettingsCard>
          <div className="space-y-3 p-4">
            {patterns.map((pattern, index) => (
              <div key={index} className="flex items-center gap-2">
                <code className="flex-1 rounded-md border border-input bg-muted/50 px-3 py-1.5 font-mono text-sm text-foreground">
                  <input
                    type="text"
                    value={pattern}
                    onChange={(e) => handleEdit(index, e.target.value)}
                    className="w-full bg-transparent outline-none"
                    spellCheck={false}
                  />
                </code>
                <button
                  onClick={() => handleRemove(index)}
                  className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
                  aria-label="Remove pattern"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}

            <div className="flex items-center gap-2">
              <div className="flex flex-1 items-center rounded-md border border-input bg-muted/50 px-3 py-1.5">
                <input
                  type="text"
                  value={draft}
                  onChange={(e) => { setDraft(e.target.value); setError(null); }}
                  onKeyDown={handleKeyDown}
                  placeholder="e.g. ^ping$ or ^daily-.*"
                  className="w-full bg-transparent font-mono text-sm text-foreground outline-none placeholder:text-muted-foreground/50"
                  spellCheck={false}
                />
              </div>
              <button
                onClick={handleAdd}
                disabled={!draft.trim()}
                className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40"
                aria-label="Add pattern"
              >
                <Plus className="h-4 w-4" />
              </button>
            </div>

            {error && (
              <p className="text-xs text-destructive">{error}</p>
            )}
          </div>
        </SettingsCard>
      </SettingsSection>
    </div>
  );
}

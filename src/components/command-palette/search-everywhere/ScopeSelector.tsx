import { useTranslation } from 'react-i18next';
import { Archive } from 'lucide-react';

import { cn } from '../../../lib/utils';

import { SCOPE_PRESETS, type ScopePreset, type ScopeState } from './scopeModel';

const SCOPE_LABELS: Record<ScopePreset, string> = {
  'current-project': 'Current project',
  'all-projects': 'All projects',
  running: 'Running',
  favorites: 'Favorites',
  'recently-viewed': 'Recently viewed',
  'recently-active': 'Recently active (7 days)',
  archived: 'Archived',
};

type ScopeSelectorProps = {
  value: ScopeState;
  onChange: (next: ScopeState) => void;
  /** Presets to hide (e.g. current-project when no project is selected). */
  disabledPresets?: ReadonlySet<ScopePreset>;
  className?: string;
};

/**
 * Scope preset dropdown + include-archived toggle (#16). Shared by the
 * Search Everywhere dialog and (once wired) the sidebar header. A native
 * <select> keeps it keyboard/mobile friendly with no popover plumbing.
 */
export default function ScopeSelector({ value, onChange, disabledPresets, className }: ScopeSelectorProps) {
  const { t } = useTranslation('common');
  const archivedPreset = value.scope === 'archived';

  return (
    <div className={cn('flex items-center gap-2 text-xs', className)}>
      <label className="sr-only" htmlFor="search-scope-select">
        {t('searchEverywhere.scope.label', 'Search scope')}
      </label>
      <select
        id="search-scope-select"
        value={value.scope}
        onChange={(e) => onChange({ ...value, scope: e.target.value as ScopePreset })}
        className="h-7 rounded-md border border-border/60 bg-muted/40 px-1.5 text-xs text-foreground outline-none focus-visible:ring-1 focus-visible:ring-ring"
      >
        {SCOPE_PRESETS.map((preset) => (
          <option key={preset} value={preset} disabled={disabledPresets?.has(preset)}>
            {t(`searchEverywhere.scope.presets.${preset}`, SCOPE_LABELS[preset])}
          </option>
        ))}
      </select>
      <button
        type="button"
        role="switch"
        aria-checked={value.includeArchived || archivedPreset}
        disabled={archivedPreset}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => onChange({ ...value, includeArchived: !value.includeArchived })}
        title={t('searchEverywhere.scope.includeArchivedHint', 'Include archived (⌥N or double-Shift again widens scope)')}
        className={cn(
          'inline-flex h-7 items-center gap-1 rounded-md border px-2 transition-colors disabled:opacity-50',
          value.includeArchived || archivedPreset
            ? 'border-primary/50 bg-primary/10 text-foreground'
            : 'border-border/60 text-muted-foreground hover:text-foreground',
        )}
      >
        <Archive className="h-3 w-3" aria-hidden />
        {t('searchEverywhere.scope.includeArchived', 'Include archived')}
      </button>
    </div>
  );
}

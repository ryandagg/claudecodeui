import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { RotateCcw } from 'lucide-react';

import SettingsSection from '../SettingsSection';
import { Button } from '../../../../shared/view/ui';
import {
  SHORTCUT_DEFINITIONS,
  eventToBinding,
  formatBinding,
  useKeyboardShortcuts,
  type ShortcutActionId,
} from '../../../../hooks/useKeyboardShortcuts';

function ShortcutRow({
  labelKey,
  descriptionKey,
  binding,
  isRecording,
  onStartRecording,
  onStopRecording,
  onCapture,
  onReset,
  isDefault,
}: {
  labelKey: string;
  descriptionKey: string;
  binding: string;
  isRecording: boolean;
  onStartRecording: () => void;
  onStopRecording: () => void;
  onCapture: (binding: string) => void;
  onReset: () => void;
  isDefault: boolean;
}) {
  const { t } = useTranslation('settings');
  const buttonRef = useRef<HTMLButtonElement>(null);

  // While recording, capture the next non-modifier key combo from this button.
  useEffect(() => {
    if (!isRecording) return undefined;

    const onKeyDown = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (event.key === 'Escape') {
        onStopRecording();
        return;
      }
      const captured = eventToBinding(event);
      if (captured) {
        onCapture(captured);
      }
    };

    // Capture phase so we intercept before any global shortcut handler fires.
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [isRecording, onCapture, onStopRecording]);

  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border border-border p-3">
      <div className="min-w-0 pr-3">
        <div className="text-sm font-medium text-foreground">{t(labelKey)}</div>
        <div className="text-xs text-muted-foreground">{t(descriptionKey)}</div>
      </div>
      <div className="flex flex-shrink-0 items-center gap-2">
        <button
          ref={buttonRef}
          type="button"
          onClick={isRecording ? onStopRecording : onStartRecording}
          onBlur={onStopRecording}
          aria-label={t('shortcuts.editBinding')}
          className={
            'min-w-[7rem] rounded-md border px-3 py-1.5 text-center font-mono text-sm transition-colors ' +
            (isRecording
              ? 'animate-pulse border-primary bg-primary/10 text-primary'
              : 'border-border bg-background text-foreground hover:bg-accent/50')
          }
        >
          {isRecording ? t('shortcuts.recording') : formatBinding(binding) || t('shortcuts.unassigned')}
        </button>
        <Button
          variant="ghost"
          size="sm"
          onClick={onReset}
          disabled={isDefault}
          aria-label={t('shortcuts.resetBinding')}
          className="h-8 w-8 p-0 text-muted-foreground hover:text-foreground disabled:opacity-30"
        >
          <RotateCcw className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}

export default function KeyboardShortcutsSettingsTab() {
  const { t } = useTranslation('settings');
  const { bindings, setBinding, resetBinding } = useKeyboardShortcuts();
  const [recordingId, setRecordingId] = useState<ShortcutActionId | null>(null);
  // Which action rejected the last capture, and the combo it already owns.
  const [rejected, setRejected] = useState<{
    id: ShortcutActionId;
    conflictWith: ShortcutActionId;
  } | null>(null);

  const handleCapture = useCallback(
    (id: ShortcutActionId, binding: string) => {
      const conflictWith = setBinding(id, binding);
      // Stay in recording mode on a conflict so the next press replaces it
      // directly, instead of making the user re-open the recorder.
      if (conflictWith) {
        setRejected({ id, conflictWith });
        return;
      }
      setRejected(null);
      setRecordingId(null);
    },
    [setBinding],
  );

  const startRecording = useCallback((id: ShortcutActionId) => {
    setRejected(null);
    setRecordingId(id);
  }, []);

  const labelFor = (id: ShortcutActionId): string => {
    const def = SHORTCUT_DEFINITIONS.find((d) => d.id === id);
    return def ? t(def.labelKey) : id;
  };

  return (
    <div className="space-y-8">
      <SettingsSection title={t('shortcuts.title')} description={t('shortcuts.description')}>
        <div className="space-y-2">
          {SHORTCUT_DEFINITIONS.map((def) => (
            <div key={def.id} className="space-y-1">
              <ShortcutRow
                labelKey={def.labelKey}
                descriptionKey={def.descriptionKey}
                binding={bindings[def.id]}
                isRecording={recordingId === def.id}
                onStartRecording={() => startRecording(def.id)}
                onStopRecording={() => {
                  setRecordingId((current) => (current === def.id ? null : current));
                  setRejected((current) => (current?.id === def.id ? null : current));
                }}
                onCapture={(binding) => handleCapture(def.id, binding)}
                onReset={() => resetBinding(def.id)}
                isDefault={bindings[def.id] === def.defaultBinding}
              />
              {rejected?.id === def.id && (
                <p role="alert" className="px-1 text-xs text-amber-600 dark:text-amber-500">
                  {t('shortcuts.conflictRejected', { action: labelFor(rejected.conflictWith) })}
                </p>
              )}
            </div>
          ))}
        </div>
        <div className="space-y-1">
          <p className="text-xs text-muted-foreground">{t('shortcuts.hint')}</p>
          <p className="text-xs text-muted-foreground">{t('shortcuts.reservedNote')}</p>
        </div>
      </SettingsSection>
    </div>
  );
}

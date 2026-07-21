import { useTranslation } from 'react-i18next';
import { useMemo, useCallback, useEffect, useRef, useState  } from 'react';
import { createPortal } from 'react-dom';
import type {
  ChangeEvent,
  ClipboardEvent,
  FormEvent,
  KeyboardEvent,
  MouseEvent,
  ReactNode,
  RefObject,
  TouchEvent,
} from 'react';
import {
  ImageIcon,
  MessageSquareIcon,
  XIcon,
  ArrowUpIcon,
  Loader2,
  CopyIcon,
  CheckIcon,
  ChevronDown,
  Check,
} from 'lucide-react';

import { useVoiceInput } from '../../hooks/useVoiceInput';
import { useVoiceAvailable } from '../../hooks/useVoiceAvailable';
import type { SessionActivity } from '../../../../hooks/useSessionProtection';
import type { PendingPermissionRequest, PermissionMode } from '../../types/types';
import type { QueuedDraft } from '../../hooks/useChatComposerState';
import type { ProviderModelOption } from '../../../../types/app';
import { DEFAULT_EFFORT_VALUE } from '../../constants/providerEffort';
import {
  PromptInput,
  PromptInputHeader,
  PromptInputBody,
  PromptInputTextarea,
  PromptInputFooter,
  PromptInputTools,
  PromptInputButton,
  PromptInputSubmit,
} from '../../../../shared/view/ui';

import CommandMenu from './CommandMenu';
import ActivityIndicator from './ActivityIndicator';
import ImageAttachment from './ImageAttachment';
import VoiceInputButton from './VoiceInputButton';
import PermissionRequestsBanner from './PermissionRequestsBanner';
import TokenUsageSummary from './TokenUsageSummary';
import QueuedMessageCard from './QueuedMessageCard';

interface MentionableFile {
  name: string;
  path: string;
}

interface SlashCommand {
  name: string;
  description?: string;
  namespace?: string;
  path?: string;
  type?: string;
  metadata?: Record<string, unknown>;
  [key: string]: unknown;
}

interface ChatComposerProps {
  pendingPermissionRequests: PendingPermissionRequest[];
  handlePermissionDecision: (
    requestIds: string | string[],
    decision: { allow?: boolean; message?: string; rememberEntry?: string | null; updatedInput?: unknown },
  ) => void;
  activity: SessionActivity | null;
  isLoading: boolean;
  onAbortSession: () => void;
  permissionMode: PermissionMode | string;
  onModeSwitch: () => void;
  effort: string;
  availableEffortOptions: NonNullable<ProviderModelOption['effort']>['values'];
  onSelectEffort: (effort: string) => void;
  tokenBudget: Record<string, unknown> | null;
  onShowTokenUsage: () => void;
  slashCommandsCount: number;
  onToggleCommandMenu: () => void;
  hasInput: boolean;
  onClearInput: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement> | MouseEvent<HTMLButtonElement> | TouchEvent<HTMLButtonElement>) => void;
  isDragActive: boolean;
  attachedImages: File[];
  onRemoveImage: (index: number) => void;
  uploadingImages: Map<string, number>;
  imageErrors: Map<string, string>;
  showFileDropdown: boolean;
  filteredFiles: MentionableFile[];
  selectedFileIndex: number;
  onSelectFile: (file: MentionableFile) => void;
  filteredCommands: SlashCommand[];
  selectedCommandIndex: number;
  onCommandSelect: (command: SlashCommand, index: number, isHover: boolean) => void;
  onCloseCommandMenu: () => void;
  isCommandMenuOpen: boolean;
  frequentCommands: SlashCommand[];
  getRootProps: (...args: unknown[]) => Record<string, unknown>;
  getInputProps: (...args: unknown[]) => Record<string, unknown>;
  openImagePicker: () => void;
  inputHighlightRef: RefObject<HTMLDivElement>;
  renderInputWithMentions: (text: string) => ReactNode;
  textareaRef: RefObject<HTMLTextAreaElement>;
  input: string;
  onVoiceTranscript?: (text: string, send?: boolean) => void;
  onInputChange: (event: ChangeEvent<HTMLTextAreaElement>) => void;
  onTextareaClick: (event: MouseEvent<HTMLTextAreaElement>) => void;
  onTextareaKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  onTextareaPaste: (event: ClipboardEvent<HTMLTextAreaElement>) => void;
  onTextareaScrollSync: (target: HTMLTextAreaElement) => void;
  onTextareaInput: (event: FormEvent<HTMLTextAreaElement>) => void;
  onInputFocusChange?: (focused: boolean) => void;
  placeholder: string;
  isTextareaExpanded: boolean;
  sendByCtrlEnter?: boolean;
  sessionJsonlPath?: string | null;
  queuedDraft: QueuedDraft | null;
  onEditQueuedDraft: () => void;
  onDeleteQueuedDraft: () => void;
  onSendQueuedDraftNow: () => void;
}

export default function ChatComposer({
  pendingPermissionRequests,
  handlePermissionDecision,
  activity,
  isLoading,
  onAbortSession,
  permissionMode,
  onModeSwitch,
  effort,
  availableEffortOptions,
  onSelectEffort,
  tokenBudget,
  onShowTokenUsage,
  slashCommandsCount,
  onToggleCommandMenu,
  hasInput,
  onClearInput,
  onSubmit,
  isDragActive,
  attachedImages,
  onRemoveImage,
  uploadingImages,
  imageErrors,
  showFileDropdown,
  filteredFiles,
  selectedFileIndex,
  onSelectFile,
  filteredCommands,
  selectedCommandIndex,
  onCommandSelect,
  onCloseCommandMenu,
  isCommandMenuOpen,
  frequentCommands,
  getRootProps,
  getInputProps,
  openImagePicker,
  inputHighlightRef,
  renderInputWithMentions,
  textareaRef,
  input,
  onVoiceTranscript,
  onInputChange,
  onTextareaClick,
  onTextareaKeyDown,
  onTextareaPaste,
  onTextareaScrollSync,
  onTextareaInput,
  onInputFocusChange,
  placeholder,
  isTextareaExpanded,
  sendByCtrlEnter,
  sessionJsonlPath,
  queuedDraft,
  onEditQueuedDraft,
  onDeleteQueuedDraft,
  onSendQueuedDraftNow,
}: ChatComposerProps) {
  const { t } = useTranslation('chat');
  const [pathCopied, setPathCopied] = useState(false);
  const pathCopyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [isEffortMenuOpen, setIsEffortMenuOpen] = useState(false);
  const [effortMenuPosition, setEffortMenuPosition] = useState<{ top: number; left: number } | null>(null);
  const effortButtonRef = useRef<HTMLButtonElement | null>(null);
  const effortMenuRef = useRef<HTMLDivElement | null>(null);

  const computeEffortMenuPosition = useCallback(() => {
    const button = effortButtonRef.current;
    if (!button) return null;
    const rect = button.getBoundingClientRect();
    // Render menu above the button. Height budget is estimated; the menu
    // scrolls if it overflows.
    const menuHeightBudget = Math.min(240, 44 + availableEffortOptions.length * 32);
    return {
      top: rect.top - menuHeightBudget - 8,
      left: rect.left,
    };
  }, [availableEffortOptions.length]);

  const openEffortMenu = useCallback(() => {
    const pos = computeEffortMenuPosition();
    if (pos) setEffortMenuPosition(pos);
    setIsEffortMenuOpen(true);
  }, [computeEffortMenuPosition]);

  const closeEffortMenu = useCallback(() => {
    setIsEffortMenuOpen(false);
  }, []);

  useEffect(() => {
    if (!isEffortMenuOpen) return;
    const handleMouseDown = (event: globalThis.MouseEvent) => {
      const target = event.target as Node;
      if (
        effortMenuRef.current?.contains(target) ||
        effortButtonRef.current?.contains(target)
      ) {
        return;
      }
      closeEffortMenu();
    };
    const handleKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        closeEffortMenu();
      }
    };
    const handleReposition = () => {
      const pos = computeEffortMenuPosition();
      if (pos) setEffortMenuPosition(pos);
    };
    document.addEventListener('mousedown', handleMouseDown);
    document.addEventListener('keydown', handleKey);
    window.addEventListener('scroll', handleReposition, true);
    window.addEventListener('resize', handleReposition);
    return () => {
      document.removeEventListener('mousedown', handleMouseDown);
      document.removeEventListener('keydown', handleKey);
      window.removeEventListener('scroll', handleReposition, true);
      window.removeEventListener('resize', handleReposition);
    };
  }, [closeEffortMenu, computeEffortMenuPosition, isEffortMenuOpen]);

  const effortLabel = effort === DEFAULT_EFFORT_VALUE
    ? t('input.effort.default', { defaultValue: 'default' })
    : effort;
  const handleCopySessionPath = useCallback(() => {
    if (!sessionJsonlPath) return;
    void navigator.clipboard.writeText(sessionJsonlPath).then(() => {
      setPathCopied(true);
      if (pathCopyTimer.current) clearTimeout(pathCopyTimer.current);
      pathCopyTimer.current = setTimeout(() => setPathCopied(false), 1500);
    });
  }, [sessionJsonlPath]);
  useEffect(() => {
    return () => {
      if (pathCopyTimer.current) clearTimeout(pathCopyTimer.current);
    };
  }, []);
  const commandMenuPosition = useMemo(() => {
    if (!isCommandMenuOpen) {
      return { top: 0, left: 16, bottom: 90 };
    }
    const textareaRect = textareaRef.current?.getBoundingClientRect();
    return {
      top: textareaRect ? Math.max(16, textareaRect.top - 316) : 0,
      left: textareaRect ? textareaRect.left : 16,
      bottom: textareaRect ? window.innerHeight - textareaRect.top + 8 : 90,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [input, isCommandMenuOpen, textareaRef]);

  // Voice state is hosted here (not in the mic button) so the main Send button can stop
  // recording and send the transcript in one tap, the way the mic button drops it in the box.
  const voiceAvailable = useVoiceAvailable();
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const voiceErrorTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleVoiceError = useCallback((msg: string) => {
    setVoiceError(msg);
    if (voiceErrorTimer.current) clearTimeout(voiceErrorTimer.current);
    voiceErrorTimer.current = setTimeout(() => setVoiceError(null), 4000);
  }, []);
  useEffect(() => () => {
    if (voiceErrorTimer.current) clearTimeout(voiceErrorTimer.current);
  }, []);
  const noopTranscript = useCallback(() => {}, []);
  const { state: voiceState, toggle: voiceToggle, stop: voiceStop } = useVoiceInput(
    onVoiceTranscript ?? noopTranscript,
    handleVoiceError,
  );
  const isRecording = voiceState === 'recording';
  const isTranscribing = voiceState === 'transcribing';

  // Detect if the AskUserQuestion interactive panel is active
  const hasQuestionPanel = pendingPermissionRequests.some(
    (r) => r.toolName === 'AskUserQuestion'
  );

  // Hide the thinking/status bar while any permission request is pending
  const hasPendingPermissions = pendingPermissionRequests.length > 0;

  const hasQueuedDraft = Boolean(queuedDraft);
  const canQueueDraft = isLoading && Boolean(input.trim());

  return (
    <div className="chat-composer-shell relative z-50 flex-shrink-0 p-2 pb-2 sm:p-4 sm:pb-4 md:p-4 md:pb-6">
      {!hasPendingPermissions && (
        <ActivityIndicator activity={activity} onAbort={onAbortSession} />
      )}

      {pendingPermissionRequests.length > 0 && (
        <div className="mx-auto mb-3 max-w-4xl">
          <PermissionRequestsBanner
            pendingPermissionRequests={pendingPermissionRequests}
            handlePermissionDecision={handlePermissionDecision}
          />
        </div>
      )}

      {!hasQuestionPanel && <div className="relative mx-auto max-w-4xl">
        {showFileDropdown && filteredFiles.length > 0 && (
          <div className="absolute bottom-full left-0 right-0 z-50 mb-2 max-h-48 overflow-y-auto rounded-xl border border-border/50 bg-card/95 shadow-lg backdrop-blur-md">
            {filteredFiles.map((file, index) => (
              <div
                key={file.path}
                className={`cursor-pointer touch-manipulation border-b border-border/30 px-4 py-3 last:border-b-0 ${
                  index === selectedFileIndex
                    ? 'bg-primary/8 text-primary'
                    : 'text-foreground hover:bg-accent/50'
                }`}
                onMouseDown={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                }}
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  onSelectFile(file);
                }}
              >
                <div className="text-sm font-medium">{file.name}</div>
                <div className="font-mono text-xs text-muted-foreground">{file.path}</div>
              </div>
            ))}
          </div>
        )}

        <CommandMenu
          commands={filteredCommands}
          selectedIndex={selectedCommandIndex}
          onSelect={onCommandSelect}
          onClose={onCloseCommandMenu}
          position={commandMenuPosition}
          isOpen={isCommandMenuOpen}
          frequentCommands={frequentCommands}
        />

        {queuedDraft && (
          <QueuedMessageCard
            content={queuedDraft.content}
            imageCount={queuedDraft.images.length}
            onEdit={onEditQueuedDraft}
            onDelete={onDeleteQueuedDraft}
            onSendNow={onSendQueuedDraftNow}
          />
        )}

        <PromptInput
          onSubmit={onSubmit as (event: FormEvent<HTMLFormElement>) => void}
          status={isLoading ? 'streaming' : 'ready'}
          className={isTextareaExpanded ? 'chat-input-expanded' : ''}
          {...getRootProps()}
        >
          {isDragActive && (
            <div className="absolute inset-0 z-50 flex items-center justify-center rounded-2xl border-2 border-dashed border-primary/50 bg-primary/15">
              <div className="rounded-xl border border-border/30 bg-card p-4 shadow-lg">
                <svg className="mx-auto mb-2 h-8 w-8 text-primary" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12"
                  />
                </svg>
                <p className="text-sm font-medium">Drop images here</p>
              </div>
            </div>
          )}

          {attachedImages.length > 0 && (
            <PromptInputHeader>
              <div className="rounded-xl bg-muted/40 p-2">
                <div className="flex flex-wrap gap-2">
                  {attachedImages.map((file, index) => (
                    <ImageAttachment
                      key={index}
                      file={file}
                      onRemove={() => onRemoveImage(index)}
                      uploadProgress={uploadingImages.get(file.name)}
                      error={imageErrors.get(file.name)}
                    />
                  ))}
                </div>
              </div>
            </PromptInputHeader>
          )}

          <input {...getInputProps()} />

          <PromptInputBody>
            <div ref={inputHighlightRef} aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-hidden rounded-xl">
              <div className="chat-input-placeholder block w-full whitespace-pre-wrap break-words px-4 py-2 text-sm leading-6 text-transparent">
                {renderInputWithMentions(input)}
              </div>
            </div>

            <PromptInputTextarea
              ref={textareaRef}
              dir="auto"
              value={input}
              onChange={onInputChange}
              onClick={onTextareaClick}
              onKeyDown={onTextareaKeyDown}
              onPaste={onTextareaPaste}
              onScroll={(event) => onTextareaScrollSync(event.target as HTMLTextAreaElement)}
              onFocus={() => onInputFocusChange?.(true)}
              onBlur={() => onInputFocusChange?.(false)}
              onInput={onTextareaInput}
              placeholder={placeholder}
            />
        </PromptInputBody>

        <PromptInputFooter>
          <PromptInputTools>
            <PromptInputButton
              tooltip={{ content: t('input.attachImages') }}
              onClick={openImagePicker}
            >
              <ImageIcon />
            </PromptInputButton>

            {onVoiceTranscript && voiceAvailable && (
              <VoiceInputButton state={voiceState} onToggle={voiceToggle} errorMsg={voiceError} />
            )}

            <button
              type="button"
              onClick={onModeSwitch}
              className={`rounded-lg border p-2 text-xs font-medium transition-all duration-200 sm:px-2.5 sm:py-1 ${
                permissionMode === 'default'
                  ? 'border-border/60 bg-muted/50 text-muted-foreground hover:bg-muted'
                  : permissionMode === 'acceptEdits'
                    ? 'border-green-300/60 bg-green-50 text-green-700 hover:bg-green-100 dark:border-green-600/40 dark:bg-green-900/15 dark:text-green-300 dark:hover:bg-green-900/25'
                    : permissionMode === 'auto'
                      ? 'border-blue-300/60 bg-blue-50 text-blue-700 hover:bg-blue-100 dark:border-blue-600/40 dark:bg-blue-900/15 dark:text-blue-300 dark:hover:bg-blue-900/25'
                      : permissionMode === 'bypassPermissions'
                        ? 'border-orange-300/60 bg-orange-50 text-orange-700 hover:bg-orange-100 dark:border-orange-600/40 dark:bg-orange-900/15 dark:text-orange-300 dark:hover:bg-orange-900/25'
                        : 'border-primary/20 bg-primary/5 text-primary hover:bg-primary/10'
              }`}
              title={t('input.clickToChangeMode')}
            >
              <div className="flex items-center gap-1.5">
                <div
                  className={`h-2.5 w-2.5 rounded-full sm:h-1.5 sm:w-1.5 ${
                    permissionMode === 'default'
                      ? 'bg-muted-foreground'
                      : permissionMode === 'acceptEdits'
                        ? 'bg-green-500'
                        : permissionMode === 'auto'
                          ? 'bg-blue-500'
                          : permissionMode === 'bypassPermissions'
                            ? 'bg-orange-500'
                            : 'bg-primary'
                  }`}
                />
                <span className="hidden whitespace-nowrap sm:inline">
                  {permissionMode === 'default' && t('codex.modes.default')}
                  {permissionMode === 'acceptEdits' && t('codex.modes.acceptEdits')}
                  {permissionMode === 'auto' && t('codex.modes.auto')}
                  {permissionMode === 'bypassPermissions' && t('codex.modes.bypassPermissions')}
                  {permissionMode === 'plan' && t('codex.modes.plan')}
                </span>
              </div>
            </button>

            {availableEffortOptions.length > 0 && (
              <>
                <button
                  ref={effortButtonRef}
                  type="button"
                  onClick={() => {
                    if (isEffortMenuOpen) {
                      closeEffortMenu();
                    } else {
                      openEffortMenu();
                    }
                  }}
                  className="flex items-center gap-1.5 rounded-lg border border-border/60 bg-muted/50 p-2 text-xs font-medium text-muted-foreground transition-all duration-200 hover:bg-muted sm:px-2.5 sm:py-1"
                  title={t('input.effort.tooltip', { defaultValue: 'Change reasoning effort' })}
                >
                  <span className="whitespace-nowrap">
                    {t('input.effort.label', { defaultValue: 'Effort' })}
                    {': '}
                    {effortLabel}
                  </span>
                  <ChevronDown className="h-3 w-3" />
                </button>
                {isEffortMenuOpen && effortMenuPosition && createPortal(
                  <div
                    ref={effortMenuRef}
                    role="menu"
                    style={{
                      position: 'fixed',
                      top: effortMenuPosition.top,
                      left: effortMenuPosition.left,
                      zIndex: 60,
                    }}
                    className="max-h-60 min-w-40 overflow-y-auto rounded-xl border border-border/50 bg-card/95 py-1 shadow-lg backdrop-blur-md"
                  >
                    <button
                      key={DEFAULT_EFFORT_VALUE}
                      type="button"
                      role="menuitemradio"
                      aria-checked={effort === DEFAULT_EFFORT_VALUE}
                      onClick={() => {
                        onSelectEffort(DEFAULT_EFFORT_VALUE);
                        closeEffortMenu();
                      }}
                      className={`flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-xs transition-colors ${
                        effort === DEFAULT_EFFORT_VALUE
                          ? 'bg-primary/10 text-primary'
                          : 'text-foreground hover:bg-accent/50'
                      }`}
                    >
                      <span>{t('input.effort.default', { defaultValue: 'default' })}</span>
                      {effort === DEFAULT_EFFORT_VALUE && <Check className="h-3 w-3" />}
                    </button>
                    {availableEffortOptions.map((option) => {
                      const selected = option.value === effort;
                      return (
                        <button
                          key={option.value}
                          type="button"
                          role="menuitemradio"
                          aria-checked={selected}
                          onClick={() => {
                            onSelectEffort(option.value);
                            closeEffortMenu();
                          }}
                          className={`flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-xs transition-colors ${
                            selected
                              ? 'bg-primary/10 text-primary'
                              : 'text-foreground hover:bg-accent/50'
                          }`}
                          title={option.description}
                        >
                          <span>{option.value}</span>
                          {selected && <Check className="h-3 w-3" />}
                        </button>
                      );
                    })}
                  </div>,
                  document.body,
                )}
              </>
            )}

            <TokenUsageSummary usage={tokenBudget} onClick={onShowTokenUsage} />

            <PromptInputButton
              tooltip={{ content: t('input.showAllCommands') }}
              onClick={onToggleCommandMenu}
              className="relative"
            >
              <MessageSquareIcon />
              {slashCommandsCount > 0 && (
                <span
                  className="absolute -right-1 -top-1 flex h-4 w-4 items-center justify-center rounded-full bg-primary text-[10px] font-bold text-primary-foreground"
                >
                  {slashCommandsCount}
                </span>
              )}
            </PromptInputButton>

            {hasInput && (
              <PromptInputButton
                tooltip={{ content: t('input.clearInput', { defaultValue: 'Clear input' }) }}
                onClick={onClearInput}
                className="hidden sm:flex"
              >
                <XIcon />
              </PromptInputButton>
            )}

          </PromptInputTools>

          <div className="flex items-center gap-2">
            {sessionJsonlPath ? (
              <button
                type="button"
                onClick={handleCopySessionPath}
                title={t('input.sessionPath.tooltip', {
                  defaultValue: 'Copy session transcript path for handoff to another agent',
                })}
                className="hidden max-w-[46ch] items-center gap-1.5 rounded px-1.5 py-0.5 font-mono text-xs text-muted-foreground/50 transition-opacity duration-200 hover:text-muted-foreground/80 lg:flex"
              >
                {pathCopied ? (
                  <CheckIcon className="h-3 w-3 shrink-0" />
                ) : (
                  <CopyIcon className="h-3 w-3 shrink-0" />
                )}
                {/* dir=rtl puts the ellipsis on the left (keeps the session-id
                    filename visible); the inner bdi keeps the path itself LTR so
                    the leading slash doesn't visually jump to the end. */}
                <span className="truncate" dir="rtl">
                  <bdi dir="ltr">{sessionJsonlPath}</bdi>
                </span>
              </button>
            ) : (
              <div
                className={`hidden text-xs text-muted-foreground/50 transition-opacity duration-200 lg:block ${
                  input.trim() ? (canQueueDraft ? 'opacity-100' : 'opacity-0') : 'opacity-100'
                }`}
              >
                {canQueueDraft
                  ? t('input.queue.hint', { defaultValue: 'Enter to queue your next message' })
                  : sendByCtrlEnter
                    ? t('input.hintText.ctrlEnter')
                    : t('input.hintText.enter')}
              </div>
            )}
            <PromptInputSubmit
              onClick={
                canQueueDraft
                  ? (e: MouseEvent<HTMLButtonElement>) => {
                      e.preventDefault();
                      onSubmit(e);
                    }
                  : isLoading
                    ? onAbortSession
                    : isRecording
                      ? (e: MouseEvent<HTMLButtonElement>) => {
                          e.preventDefault();
                          voiceStop({ send: true });
                        }
                      : undefined
              }
              disabled={
                canQueueDraft
                  ? hasQueuedDraft
                  : isLoading
                    ? false
                    : isRecording
                      ? false
                      : isTranscribing
                        ? true
                        : !input.trim()
              }
              className="h-10 w-10 sm:h-10 sm:w-10"
              aria-label={canQueueDraft ? t('input.queue.queueSend', { defaultValue: 'Queue message' }) : undefined}
            >
              {canQueueDraft ? (
                <ArrowUpIcon className="h-4 w-4" />
              ) : isTranscribing ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : undefined}
            </PromptInputSubmit>
          </div>
        </PromptInputFooter>
      </PromptInput>
      </div>}
    </div>
  );
}

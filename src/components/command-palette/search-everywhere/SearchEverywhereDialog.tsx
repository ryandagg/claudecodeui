import * as React from 'react';
import { useTranslation } from 'react-i18next';
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  ChevronRight,
  FileText,
  GitCommit,
  GitMerge,
  Loader2,
  MessageSquare,
  MessageSquarePlus,
  MessagesSquare,
  RefreshCw,
  Settings,
  SunMoon,
} from 'lucide-react';

import {
  Command,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  Dialog,
  DialogContent,
  DialogTitle,
} from '../../../shared/view/ui';
import { cn } from '../../../lib/utils';
import { useTheme } from '../../../contexts/ThemeContext';
import { usePaletteOps } from '../../../contexts/PaletteOpsContext';
import { formatBinding } from '../../../hooks/useKeyboardShortcuts';
import { SETTINGS_MAIN_TABS } from '../../settings/constants/constants';
import type { AppTab, Project, ProjectSession } from '../../../types/app';
import { useSessionsSource } from '../sources/useSessionsSource';
import { useFilesSource } from '../sources/useFilesSource';
import { useCommitsSource } from '../sources/useCommitsSource';
import { useBranchesSource } from '../sources/useBranchesSource';
import { useGitActions } from '../sources/useGitActions';

import {
  buildMessageHitSelection,
  cycleTab,
  filterAndRank,
  splitHighlights,
  visibleTabs,
  type MessageHit,
  type SearchTabId,
} from './searchEverywhereModel';
import { MIN_MESSAGE_QUERY, useMessageHits } from './useMessageHits';
import { useSearchEverywhereDialogKeys, useSearchEverywhereTriggers } from './useSearchEverywhereKeys';

/** Tabs with a data source today. `text` joins when #23 lands. */
const AVAILABLE_TABS = new Set<SearchTabId>(['all', 'sessions', 'messages', 'files', 'actions', 'git']);
const TABS = visibleTabs(AVAILABLE_TABS);

/** Rows per group on the All tab before a "more…" row. */
const ALL_TAB_LIMIT = 5;
/** Rows rendered on a dedicated tab (virtualisation arrives with #25). */
const TAB_LIMIT = 100;

type GroupId = 'actions' | 'sessions' | 'messages' | 'files' | 'git';

type IconComponent = React.ComponentType<{ className?: string }>;

type Row = {
  key: string;
  icon: IconComponent;
  label: React.ReactNode;
  detail?: React.ReactNode;
  hint?: React.ReactNode;
  disabled?: boolean;
  onSelect: () => void;
};

type Group = { id: GroupId; tab: SearchTabId; heading: string; rows: Row[]; total: number; status?: React.ReactNode };

type SearchEverywhereDialogProps = {
  projects: Project[];
  selectedProject: Project | null;
  onStartNewChat: (project: Project) => void;
  onOpenSettings: (tab?: string) => void;
  onShowTab?: (tab: AppTab) => void;
  onSelectProject: (project: Project) => void;
  onSelectSession: (session: ProjectSession) => void;
};

type SessionEntry = { session: ProjectSession; project: Project | null; label: string };

export default function SearchEverywhereDialog({
  projects,
  selectedProject,
  onStartNewChat,
  onOpenSettings,
  onShowTab,
  onSelectProject,
  onSelectSession,
}: SearchEverywhereDialogProps) {
  const { t } = useTranslation('common');
  const [open, setOpen] = React.useState(false);
  const [tab, setTab] = React.useState<SearchTabId>('all');
  const [search, setSearch] = React.useState('');
  const [selectedValue, setSelectedValue] = React.useState('');
  const listRef = React.useRef<HTMLDivElement | null>(null);
  const { toggleDarkMode } = useTheme();
  const ops = usePaletteOps();

  useSearchEverywhereTriggers(TABS, true, {
    onToggle: () => {
      if (!open) setTab('all');
      setOpen(!open);
    },
    onOpenTab: (next) => {
      setTab(next);
      setOpen(true);
    },
  });

  React.useEffect(() => {
    if (!open) {
      setSearch('');
      setSelectedValue('');
    }
  }, [open]);

  const jumpTo = React.useCallback((edge: 'first' | 'last') => {
    const items = listRef.current?.querySelectorAll<HTMLElement>('[cmdk-item]:not([aria-disabled="true"])');
    if (!items || items.length === 0) return;
    const target = edge === 'first' ? items[0] : items[items.length - 1];
    const value = target.getAttribute('data-value');
    if (value) {
      setSelectedValue(value);
      target.scrollIntoView({ block: 'nearest' });
    }
  }, []);

  useSearchEverywhereDialogKeys(open, {
    onCycle: (direction) => setTab((current) => cycleTab(TABS, current, direction)),
    onJump: jumpTo,
  });

  const projectId = selectedProject?.projectId;
  const wants = (t2: SearchTabId) => open && (tab === 'all' || tab === t2);

  const fetchedSessions = useSessionsSource(projectId, wants('sessions'));
  const files = useFilesSource(projectId, wants('files'));
  const commits = useCommitsSource(projectId, wants('git'));
  const branches = useBranchesSource(projectId, wants('git'));
  const git = useGitActions(projectId);
  const { hits: messageHits, loading: messagesLoading } = useMessageHits(search, wants('messages'));

  const run = React.useCallback((fn: () => void) => {
    setOpen(false);
    fn();
  }, []);

  // --- Sessions: everything the sidebar has loaded + the current project's
  // first page. Current project first so its sessions win ties. (Server-side
  // title search replaces this with #14.)
  const sessionEntries = React.useMemo<SessionEntry[]>(() => {
    const seen = new Set<string>();
    const out: SessionEntry[] = [];
    const push = (session: ProjectSession, project: Project | null) => {
      if (seen.has(session.id)) return;
      seen.add(session.id);
      out.push({ session, project, label: String(session.title || session.summary || session.name || session.id) });
    };
    if (selectedProject) {
      for (const s of selectedProject.sessions ?? []) push(s, selectedProject);
      for (const s of fetchedSessions) {
        push({ id: s.id, title: s.label, __provider: s.provider }, selectedProject);
      }
    }
    for (const project of projects) {
      if (project.projectId === projectId) continue;
      for (const s of project.sessions ?? []) push(s, project);
    }
    return out;
  }, [fetchedSessions, projectId, projects, selectedProject]);

  const openSession = React.useCallback((entry: SessionEntry) => {
    run(() => {
      const pid = entry.project?.projectId ?? entry.session.__projectId;
      if (entry.project && entry.project.projectId !== projectId) onSelectProject(entry.project);
      onSelectSession({
        ...entry.session,
        __provider: entry.session.__provider || entry.session.provider,
        __projectId: pid,
      });
    });
  }, [onSelectProject, onSelectSession, projectId, run]);

  const openMessageHit = React.useCallback((hit: MessageHit) => {
    run(() => {
      const { project, session } = buildMessageHitSelection(hit, projects, search.trim());
      if (project) onSelectProject(project);
      onSelectSession(session as ProjectSession);
    });
  }, [onSelectProject, onSelectSession, projects, run, search]);

  // --- Actions: one flat, filterable list (nav, git, settings included).
  type Action = { key: string; label: string; keywords: string; icon: IconComponent; disabled?: boolean; hint?: string; perform: () => void };
  const actions = React.useMemo<Action[]>(() => {
    const list: Action[] = [
      {
        key: 'new-chat',
        label: t('searchEverywhere.actions.newChat', 'Start new chat'),
        keywords: 'new chat session conversation',
        icon: MessageSquarePlus,
        disabled: !selectedProject,
        hint: selectedProject ? undefined : t('searchEverywhere.actions.selectProjectFirst', 'Select a project first'),
        perform: () => { if (selectedProject) onStartNewChat(selectedProject); },
      },
      { key: 'settings', label: t('searchEverywhere.actions.openSettings', 'Open settings'), keywords: 'settings preferences', icon: Settings, perform: () => onOpenSettings() },
      { key: 'theme', label: t('searchEverywhere.actions.toggleTheme', 'Toggle theme'), keywords: 'theme dark light mode', icon: SunMoon, perform: toggleDarkMode },
    ];
    const nav: Array<{ id: AppTab; label: string; keywords: string }> = [
      { id: 'chat', label: 'Go to Chat', keywords: 'chat messages conversation' },
      { id: 'files', label: 'Go to Files', keywords: 'files file tree explorer' },
      { id: 'shell', label: 'Go to Shell', keywords: 'shell terminal console' },
      { id: 'git', label: 'Go to Git', keywords: 'git diff branches' },
      { id: 'tasks', label: 'Go to Tasks', keywords: 'tasks taskmaster' },
    ];
    for (const n of nav) {
      list.push({ key: `nav-${n.id as string}`, label: n.label, keywords: n.keywords, icon: ChevronRight, perform: () => onShowTab?.(n.id) });
    }
    if (projectId) {
      list.push(
        { key: 'git-fetch', label: 'Git: Fetch', keywords: 'git fetch remote', icon: RefreshCw, perform: () => { void git.fetch(); onShowTab?.('git'); } },
        { key: 'git-pull', label: 'Git: Pull', keywords: 'git pull merge upstream', icon: ArrowDownToLine, perform: () => { void git.pull(); onShowTab?.('git'); } },
        { key: 'git-push', label: 'Git: Push', keywords: 'git push origin remote', icon: ArrowUpFromLine, perform: () => { void git.push(); onShowTab?.('git'); } },
      );
    }
    for (const { id, label, keywords, icon } of SETTINGS_MAIN_TABS) {
      list.push({ key: `settings-${id}`, label: `Settings: ${label}`, keywords: `settings ${keywords}`, icon, perform: () => onOpenSettings(id) });
    }
    return list;
  }, [git, onOpenSettings, onShowTab, onStartNewChat, projectId, selectedProject, t, toggleDarkMode]);

  const groups = React.useMemo<Group[]>(() => {
    const q = search;
    const limit = tab === 'all' ? ALL_TAB_LIMIT : TAB_LIMIT;
    const out: Group[] = [];

    const add = (id: GroupId, groupTab: SearchTabId, heading: string, rows: Row[], status?: React.ReactNode) => {
      if (tab !== 'all' && tab !== groupTab) return;
      out.push({ id, tab: groupTab, heading, rows: rows.slice(0, limit), total: rows.length, status });
    };

    // Actions
    const rankedActions = filterAndRank(actions, q, (a) => a.label, (a) => [a.keywords]);
    add('actions', 'actions', t('searchEverywhere.groups.actions', 'Actions'), rankedActions.map((a) => ({
      key: `action:${a.key}`,
      icon: a.icon,
      label: a.label,
      hint: a.hint,
      disabled: a.disabled,
      onSelect: () => run(a.perform),
    })));

    // Sessions
    const rankedSessions = filterAndRank(sessionEntries, q, (e) => e.label, (e) => [e.project?.displayName]);
    add('sessions', 'sessions', t('searchEverywhere.groups.sessions', 'Sessions'), rankedSessions.map((e) => ({
      key: `session:${e.session.id}`,
      icon: MessageSquare,
      label: e.label,
      hint: e.project?.displayName,
      onSelect: () => openSession(e),
    })));

    // Messages — server-side, all projects
    const trimmed = q.trim();
    let messageStatus: React.ReactNode;
    if (trimmed.length < MIN_MESSAGE_QUERY) {
      messageStatus = tab === 'messages'
        ? t('searchEverywhere.messages.minChars', { count: MIN_MESSAGE_QUERY, defaultValue: 'Type at least {{count}} characters to search message content' })
        : undefined;
    } else if (messagesLoading) {
      messageStatus = (
        <span className="inline-flex items-center gap-1.5">
          <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
          {t('searchEverywhere.messages.searching', 'Searching messages…')}
        </span>
      );
    }
    add('messages', 'messages', t('searchEverywhere.groups.messages', 'Messages'), messageHits.map((hit, index) => ({
      key: `message:${hit.sessionId}:${hit.messageUuid ?? hit.timestamp ?? index}:${index}`,
      icon: MessagesSquare,
      label: <HighlightedSnippet text={hit.snippet} highlights={hit.highlights} />,
      detail: hit.sessionSummary,
      hint: hit.projectName,
      onSelect: () => openMessageHit(hit),
    })), messageStatus);

    // Files — current project
    const rankedFiles = filterAndRank(files, q, (f) => f.name, (f) => [f.path]);
    add('files', 'files', t('searchEverywhere.groups.files', 'Files'), rankedFiles.map((f) => ({
      key: `file:${f.path}`,
      icon: FileText,
      label: f.name,
      hint: f.path,
      onSelect: () => run(() => ops.openFile(f.path)),
    })));

    // Git — commits + branches, current project
    const rankedCommits = filterAndRank(commits, q, (c) => c.message, (c) => [c.author, c.shortHash, c.hash]);
    const rankedBranches = filterAndRank(branches, q, (b) => b.name);
    add('git', 'git', t('searchEverywhere.groups.git', 'Git'), [
      ...rankedBranches.map<Row>((b) => ({
        key: `branch:${b.name}`,
        icon: GitMerge,
        label: `Switch to: ${b.name}`,
        onSelect: () => run(() => { void git.checkout(b.name); onShowTab?.('git'); }),
      })),
      ...rankedCommits.map<Row>((c) => ({
        key: `commit:${c.hash}`,
        icon: GitCommit,
        label: c.message,
        detail: <span className="font-mono">{c.shortHash}</span>,
        hint: c.author,
        onSelect: () => run(() => onShowTab?.('git')),
      })),
    ]);

    return out;
  }, [actions, branches, commits, files, git, messageHits, messagesLoading, onShowTab, openMessageHit, openSession, ops, run, search, sessionEntries, t, tab]);

  const totalRows = groups.reduce((n, g) => n + g.rows.length, 0);
  const anyStatus = groups.some((g) => g.status);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-w-2xl overflow-hidden p-0" data-search-everywhere="">
        <DialogTitle>{t('searchEverywhere.title', 'Search Everywhere')}</DialogTitle>
        <Command
          label={t('searchEverywhere.title', 'Search Everywhere')}
          shouldFilter={false}
          value={selectedValue}
          onValueChange={setSelectedValue}
          loop
        >
          <div role="tablist" aria-label={t('searchEverywhere.tabsLabel', 'Search categories')} className="flex items-center gap-1 overflow-x-auto border-b px-2 pt-2">
            {TABS.map((def) => {
              const active = def.id === tab;
              return (
                // A div, not a button: the Dialog autofocuses its first
                // focusable element, and that must stay the search input.
                <div
                  key={def.id}
                  role="tab"
                  aria-selected={active}
                  data-tab={def.id}
                  title={def.shortcut ? formatBinding(def.shortcut) : undefined}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => setTab(def.id)}
                  className={cn(
                    '-mb-px cursor-pointer select-none whitespace-nowrap border-b-2 px-2.5 py-1.5 text-xs font-medium transition-colors',
                    active ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground',
                  )}
                >
                  {t(def.labelKey, def.defaultLabel)}
                </div>
              );
            })}
            <span className="ml-auto hidden whitespace-nowrap pb-1.5 text-[10px] text-muted-foreground sm:inline">
              {t('searchEverywhere.tabHint', 'Tab / ⇧Tab to switch')}
            </span>
          </div>
          <CommandInput
            placeholder={t('searchEverywhere.placeholder', 'Search sessions, messages, files, actions…')}
            value={search}
            onValueChange={setSearch}
          />
          <CommandList ref={listRef} className="max-h-[min(60vh,480px)]">
            {groups.map((group) => (
              (group.rows.length > 0 || group.status) && (
                <CommandGroup key={group.id} heading={group.heading}>
                  {group.status && (
                    <div className="px-2 py-1.5 text-xs text-muted-foreground">{group.status}</div>
                  )}
                  {group.rows.map((row) => (
                    <CommandItem key={row.key} value={row.key} disabled={row.disabled} onSelect={row.onSelect}>
                      <row.icon className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                      <div className="flex min-w-0 flex-1 flex-col">
                        <span className="truncate">{row.label}</span>
                        {row.detail && <span className="truncate text-xs text-muted-foreground">{row.detail}</span>}
                      </div>
                      {row.hint && <span className="max-w-[40%] truncate text-xs text-muted-foreground">{row.hint}</span>}
                    </CommandItem>
                  ))}
                  {tab === 'all' && group.total > group.rows.length && (
                    <CommandItem value={`more:${group.id}`} onSelect={() => setTab(group.tab)}>
                      <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                      <span className="flex-1 text-muted-foreground">
                        {t('searchEverywhere.more', { count: group.total - group.rows.length, defaultValue: 'More… ({{count}})' })}
                      </span>
                    </CommandItem>
                  )}
                </CommandGroup>
              )
            ))}
            {totalRows === 0 && !anyStatus && (
              <div className="py-6 text-center text-sm text-muted-foreground">
                {t('searchEverywhere.noResults', 'No results.')}
              </div>
            )}
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  );
}

function HighlightedSnippet({ text, highlights }: { text: string; highlights: Array<{ start: number; end: number }> }) {
  return (
    <>
      {splitHighlights(text, highlights).map((run, i) => (
        run.match
          ? <mark key={i} className="rounded-sm bg-yellow-300/40 px-0 text-inherit dark:bg-yellow-500/30">{run.text}</mark>
          : <React.Fragment key={i}>{run.text}</React.Fragment>
      ))}
    </>
  );
}

import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, Edit2, Folder, Loader2, MessageSquare, Star, Trash2, X } from 'lucide-react';
import type { TFunction } from 'i18next';

import { buttonVariants } from '../../../../shared/view/ui';
import { cn } from '../../../../lib/utils';
import type { Project } from '../../../../types/app';
import type { SessionWithProvider } from '../../types/types';
import SessionProviderLogo from '../../../llm-logo-provider/SessionProviderLogo';
import { createSessionViewModel, getSessionDate } from '../../utils/utils';

import type { SidebarProjectListProps } from './SidebarProjectList';

type FlatConversation = {
  project: Project;
  session: SessionWithProvider;
  date: Date;
};

/** Compact relative age — mirrors SidebarSessionItem's formatter. */
const formatCompactAge = (date: Date, currentTime: Date): string => {
  if (Number.isNaN(date.getTime())) {
    return '';
  }
  const diffInMinutes = Math.floor(Math.max(0, currentTime.getTime() - date.getTime()) / (1000 * 60));
  if (diffInMinutes < 1) {
    return '<1m';
  }
  if (diffInMinutes < 60) {
    return `${diffInMinutes}m`;
  }
  const diffInHours = Math.floor(diffInMinutes / 60);
  if (diffInHours < 24) {
    return `${diffInHours}hr`;
  }
  return `${Math.floor(diffInHours / 24)}d`;
};

type SidebarConversationListProps = {
  projectListProps: SidebarProjectListProps;
  /** Client-side filter applied to session title + project name. */
  searchFilter: string;
  t: TFunction;
};

/**
 * Conversations view: a flat, recency-sorted list of every loaded session.
 *
 * This is the deliberate inversion of the Projects view — sessions are the
 * primary unit, sorted by last activity across all projects, and the project
 * is shown as an informational (non-clickable) breadcrumb. Each row exposes the
 * same rename / archive-or-delete actions as the grouped view, reusing the
 * controller handlers carried in projectListProps so there's no new state.
 *
 * Note: sessions are paginated at 20-most-recent per project by the server, so
 * a project with more than that has its older sessions absent here until they
 * are paged in from the Projects view. Everything shown is correctly ordered.
 */
export default function SidebarConversationList({
  projectListProps,
  searchFilter,
  t,
}: SidebarConversationListProps) {
  const {
    projects,
    selectedSession,
    currentTime,
    activeSessions,
    editingSession,
    editingSessionName,
    getProjectSessions,
    isSessionStarred,
    onSessionSelect,
    onProjectSelect,
    onDeleteSession,
    onToggleStarSession,
    onEditingSessionNameChange,
    onStartEditingSession,
    onCancelEditingSession,
    onSaveEditingSession,
  } = projectListProps;

  const editingContainerRef = useRef<HTMLDivElement>(null);
  // Selecting the row's overflow menu happens via hover on desktop; on mobile we
  // toggle it explicitly so touch users can reach rename/delete.
  const [openMenuFor, setOpenMenuFor] = useState<string | null>(null);

  const conversations = useMemo<FlatConversation[]>(() => {
    const flattened: FlatConversation[] = [];
    for (const project of projects) {
      for (const session of getProjectSessions(project)) {
        flattened.push({ project, session, date: getSessionDate(session) });
      }
    }
    // Starred sessions bubble to the top; within each group, most recent first.
    flattened.sort((a, b) => {
      const aStarred = isSessionStarred(a.session) ? 1 : 0;
      const bStarred = isSessionStarred(b.session) ? 1 : 0;
      if (aStarred !== bStarred) {
        return bStarred - aStarred;
      }
      return b.date.getTime() - a.date.getTime();
    });

    const needle = searchFilter.trim().toLowerCase();
    if (!needle) {
      return flattened;
    }
    return flattened.filter(({ project, session }) => {
      const title = createSessionViewModel(session, currentTime, t).sessionName.toLowerCase();
      const projectName = (project.displayName || project.path || '').toLowerCase();
      return title.includes(needle) || projectName.includes(needle);
    });
  }, [projects, getProjectSessions, isSessionStarred, searchFilter, currentTime, t]);

  useEffect(() => {
    if (!editingSession) {
      return;
    }
    const handlePointerDown = (event: MouseEvent) => {
      const container = editingContainerRef.current;
      if (container && !container.contains(event.target as Node)) {
        onCancelEditingSession();
      }
    };
    document.addEventListener('mousedown', handlePointerDown);
    return () => document.removeEventListener('mousedown', handlePointerDown);
  }, [editingSession, onCancelEditingSession]);

  if (conversations.length === 0) {
    return (
      <div className="px-4 py-12 text-center md:py-8">
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-lg bg-muted md:mb-3">
          <MessageSquare className="h-6 w-6 text-muted-foreground" />
        </div>
        <h3 className="mb-2 text-base font-medium text-foreground md:mb-1">
          {searchFilter.trim()
            ? t('search.noResults', 'No conversations match')
            : t('conversations.emptyTitle', 'No conversations yet')}
        </h3>
        <p className="text-sm text-muted-foreground">
          {searchFilter.trim()
            ? t('search.tryDifferentQuery', 'Try a different search term.')
            : t('conversations.emptyDescription', 'Sessions you start will appear here, newest first.')}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-1 px-2 pb-safe-area-inset-bottom">
      {conversations.map(({ project, session }) => {
        const view = createSessionViewModel(session, currentTime, t);
        const isSelected = selectedSession?.id === session.id;
        const isProcessing = activeSessions.has(session.id);
        const isEditing = editingSession === session.id;
        const age = formatCompactAge(getSessionDate(session), currentTime);
        const menuOpen = openMenuFor === session.id;

        const isStarred = isSessionStarred(session);

        const select = () => {
          onProjectSelect(project);
          onSessionSelect(session, project.projectId);
        };
        const saveEdit = () =>
          onSaveEditingSession(project.projectId, session.id, editingSessionName, session.__provider);
        const requestDelete = () =>
          onDeleteSession(project.projectId, session.id, view.sessionName, session.__provider);
        const toggleStar = () => onToggleStarSession(session);

        return (
          <div key={`${project.projectId}-${session.id}`} className="group relative">
            <a
              href={`/session/${session.id}`}
              className={cn(
                buttonVariants({ variant: 'ghost' }),
                'h-auto w-full flex-col items-start gap-1 rounded-md border bg-card p-2 text-left font-normal transition-all duration-150',
                isSelected ? 'border-primary/20 bg-primary/5' : 'border-border/30 hover:bg-accent/50',
              )}
              onClick={(event) => {
                if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
                event.preventDefault();
                select();
              }}
            >
              <div className="flex w-full min-w-0 items-center gap-2">
                <div
                  className={cn(
                    'flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-md',
                    isSelected ? 'bg-primary/10' : 'bg-muted/50',
                  )}
                >
                  <SessionProviderLogo provider={session.__provider} className="h-3 w-3" />
                </div>
                <span className="min-w-0 flex-1 truncate text-xs font-normal text-foreground">
                  {view.sessionName}
                </span>
                {isProcessing ? (
                  <Loader2 className="h-3 w-3 flex-shrink-0 animate-spin text-muted-foreground group-hover:opacity-0" />
                ) : age ? (
                  <span className="flex-shrink-0 text-[11px] text-muted-foreground transition-opacity duration-200 group-hover:opacity-0">
                    {age}
                  </span>
                ) : null}
              </div>
              {/* Project shown as an informational, non-clickable breadcrumb. */}
              <div className="flex w-full min-w-0 items-center gap-1 pl-7">
                <Folder className="h-2.5 w-2.5 flex-shrink-0 text-muted-foreground/60" />
                <span className="truncate text-[10px] text-muted-foreground/70" title={project.fullPath || project.path}>
                  {project.displayName || project.path}
                </span>
              </div>
            </a>

            <div
              ref={isEditing ? editingContainerRef : null}
              className={cn(
                'absolute right-2 top-2 flex items-center gap-1 transition-all duration-200',
                // A starred (favorited) session keeps its star indicator visible at rest;
                // edit/delete stay hover-only via their own opacity gate below.
                isEditing || menuOpen || isStarred ? 'opacity-100' : 'opacity-0 group-hover:opacity-100',
              )}
            >
              {isEditing ? (
                <>
                  <input
                    type="text"
                    value={editingSessionName}
                    onChange={(event) => onEditingSessionNameChange(event.target.value)}
                    onKeyDown={(event) => {
                      event.stopPropagation();
                      if (event.key === 'Enter') {
                        saveEdit();
                      } else if (event.key === 'Escape') {
                        onCancelEditingSession();
                      }
                    }}
                    onClick={(event) => event.stopPropagation()}
                    className="w-32 rounded border border-border bg-background px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-primary"
                    autoFocus
                  />
                  <button
                    className="flex h-6 w-6 items-center justify-center rounded bg-green-50 hover:bg-green-100 dark:bg-green-900/20 dark:hover:bg-green-900/40"
                    onClick={(event) => {
                      event.stopPropagation();
                      saveEdit();
                    }}
                    title={t('tooltips.save')}
                  >
                    <Check className="h-3 w-3 text-green-600 dark:text-green-400" />
                  </button>
                  <button
                    className="flex h-6 w-6 items-center justify-center rounded bg-gray-50 hover:bg-gray-100 dark:bg-gray-900/20 dark:hover:bg-gray-900/40"
                    onClick={(event) => {
                      event.stopPropagation();
                      onCancelEditingSession();
                    }}
                    title={t('tooltips.cancel')}
                  >
                    <X className="h-3 w-3 text-gray-600 dark:text-gray-400" />
                  </button>
                </>
              ) : (
                <>
                  <button
                    className={cn(
                      'flex h-6 w-6 items-center justify-center rounded border transition-colors',
                      isStarred
                        ? 'bg-yellow-500/10 dark:bg-yellow-900/30 border-yellow-200 dark:border-yellow-800'
                        : 'bg-gray-500/10 dark:bg-gray-900/30 border-gray-200 dark:border-gray-800',
                    )}
                    onClick={(event) => {
                      event.stopPropagation();
                      toggleStar();
                    }}
                    title={isStarred ? t('tooltips.removeFromFavorites') : t('tooltips.addToFavorites')}
                  >
                    <Star
                      className={cn(
                        'h-3 w-3 transition-colors',
                        isStarred
                          ? 'text-yellow-600 dark:text-yellow-400 fill-current'
                          : 'text-gray-600 dark:text-gray-400',
                      )}
                    />
                  </button>
                  <button
                    className={cn(
                      'flex h-6 w-6 items-center justify-center rounded bg-gray-50 hover:bg-gray-100 dark:bg-gray-900/20 dark:hover:bg-gray-900/40',
                      // Only the star pins open on a starred row; edit stays hover-only.
                      isStarred && !menuOpen ? 'opacity-0 group-hover:opacity-100 transition-opacity duration-200' : '',
                    )}
                    onClick={(event) => {
                      event.stopPropagation();
                      setOpenMenuFor(null);
                      onStartEditingSession(session.id, view.sessionName);
                    }}
                    title={t('tooltips.editSessionName')}
                  >
                    <Edit2 className="h-3 w-3 text-gray-600 dark:text-gray-400" />
                  </button>
                  {!isProcessing && (
                    <button
                      className={cn(
                        'flex h-6 w-6 items-center justify-center rounded bg-red-50 hover:bg-red-100 dark:bg-red-900/20 dark:hover:bg-red-900/40',
                        isStarred && !menuOpen ? 'opacity-0 group-hover:opacity-100 transition-opacity duration-200' : '',
                      )}
                      onClick={(event) => {
                        event.stopPropagation();
                        setOpenMenuFor(null);
                        requestDelete();
                      }}
                      title={t('tooltips.deleteSessionOptions', 'Archive or permanently delete this session')}
                    >
                      <Trash2 className="h-3 w-3 text-red-600 dark:text-red-400" />
                    </button>
                  )}
                </>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

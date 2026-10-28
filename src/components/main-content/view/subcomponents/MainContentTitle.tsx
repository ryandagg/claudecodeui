import { useState } from 'react';
import { GitBranch, RotateCcw } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import SessionProviderLogo from '../../../llm-logo-provider/SessionProviderLogo';
import type { AppTab, Project, ProjectSession } from '../../../../types/app';
import { usePlugins } from '../../../../contexts/PluginsContext';
import { useHomedir } from '../../../../hooks/useHomedir';
import { collapseHomePath } from '../../../../utils/pathDisplay';
import { useSessionRepoInfo } from '../../hooks/useSessionRepoInfo';

type MainContentTitleProps = {
  activeTab: AppTab;
  selectedProject: Project;
  selectedSession: ProjectSession | null;
  shouldShowTasksTab: boolean;
  onRestoreSession: (sessionId: string) => Promise<boolean>;
};

/**
 * "Archived" badge + inline Restore for an archived session open in the chat
 * pane — the restore surface for a session reached from a conversation-search
 * hit, where the sidebar's Archive-tab restore button is out of reach.
 */
function ArchivedSessionControls({
  sessionId,
  onRestoreSession,
}: {
  sessionId: string;
  onRestoreSession: (sessionId: string) => Promise<boolean>;
}) {
  const { t } = useTranslation();
  const [isRestoring, setIsRestoring] = useState(false);

  const handleRestore = async () => {
    if (isRestoring) {
      return;
    }
    setIsRestoring(true);
    const restored = await onRestoreSession(sessionId);
    setIsRestoring(false);
    if (!restored) {
      alert(t('messages.restoreSessionError', 'Error restoring session. Please try again.'));
    }
  };

  return (
    <div className="flex flex-shrink-0 items-center gap-1.5">
      <span className="rounded-full bg-amber-100 px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide text-amber-700 dark:bg-amber-900/30 dark:text-amber-300">
        {t('archived.badge', 'Archived')}
      </span>
      <button
        type="button"
        onClick={handleRestore}
        disabled={isRestoring}
        className="flex items-center gap-1 rounded-md bg-emerald-50 px-1.5 py-0.5 text-[11px] font-medium text-emerald-700 transition-colors hover:bg-emerald-100 disabled:opacity-50 dark:bg-emerald-900/20 dark:text-emerald-300 dark:hover:bg-emerald-900/30"
        title={t('archived.restore', 'Restore session')}
      >
        <RotateCcw className={`h-3 w-3 ${isRestoring ? 'animate-spin' : ''}`} />
        {t('archived.restoreAction', 'Restore')}
      </button>
    </div>
  );
}

function getTabTitle(activeTab: AppTab, shouldShowTasksTab: boolean, t: (key: string) => string, pluginDisplayName?: string) {
  if (activeTab.startsWith('plugin:') && pluginDisplayName) {
    return pluginDisplayName;
  }

  if (activeTab === 'files') {
    return t('mainContent.projectFiles');
  }

  if (activeTab === 'git') {
    return t('tabs.git');
  }

  if (activeTab === 'tasks' && shouldShowTasksTab) {
    return 'TaskMaster';
  }

  if (activeTab === 'browser') {
    return t('tabs.browser');
  }

  return 'Project';
}

function getSessionTitle(session: ProjectSession): string {
  if (session.__provider === 'cursor') {
    return (session.name as string) || 'Untitled Session';
  }

  return (session.summary as string) || 'New Session';
}

/**
 * Right-aligned "<repo> · <branch>" for the subtitle line. Reads git info
 * (read-only) for the session's working directory; for a worktree the repo is
 * the originating repository. Renders nothing until resolved, and a subtle
 * hint when the directory is not a git repo.
 */
function RepoBranchBadge({ projectId }: { projectId: string | null | undefined }) {
  const { t } = useTranslation();
  const { repo, branch, isGitRepo, loading } = useSessionRepoInfo(projectId);

  if (loading && !repo) {
    return null;
  }

  if (!isGitRepo) {
    return (
      <span className="flex-shrink-0 whitespace-nowrap text-[11px] italic leading-tight text-muted-foreground/50">
        {t('mainContent.notAGitRepo', { defaultValue: 'not a git repo' })}
      </span>
    );
  }

  return (
    <span className="flex min-w-0 flex-shrink items-center gap-1 whitespace-nowrap text-[11px] leading-tight text-muted-foreground/80">
      <GitBranch className="h-3 w-3 flex-shrink-0" />
      {repo && <span className="truncate font-medium">{repo}</span>}
      {repo && branch && <span className="text-muted-foreground/40">·</span>}
      {branch && <span className="truncate">{branch}</span>}
    </span>
  );
}

export default function MainContentTitle({
  activeTab,
  selectedProject,
  selectedSession,
  shouldShowTasksTab,
  onRestoreSession,
}: MainContentTitleProps) {
  const { t } = useTranslation();
  const { plugins } = usePlugins();
  const homedir = useHomedir();

  // Subtitle shows the project's full working directory, with the home dir
  // collapsed to `~`. Falls back to the display name until the path is known.
  const projectPath = selectedProject.fullPath || selectedProject.path;
  const pathLabel = projectPath ? collapseHomePath(projectPath, homedir) : selectedProject.displayName;

  const pluginDisplayName = activeTab.startsWith('plugin:')
    ? plugins.find((p) => p.name === activeTab.replace('plugin:', ''))?.displayName
    : undefined;

  const showSessionIcon = activeTab === 'chat' && Boolean(selectedSession);
  const showChatNewSession = activeTab === 'chat' && !selectedSession;

  return (
    <div className="scrollbar-hide flex min-w-0 flex-1 items-center gap-2 overflow-x-auto">
      {showSessionIcon && (
        <div className="flex h-5 w-5 flex-shrink-0 items-center justify-center">
          <SessionProviderLogo provider={selectedSession?.__provider} className="h-4 w-4" />
        </div>
      )}

      <div className="min-w-0 flex-1">
        {activeTab === 'chat' && selectedSession ? (
          <div className="min-w-0">
            <div className="flex min-w-0 items-center gap-2">
              <h2 className="scrollbar-hide overflow-x-auto whitespace-nowrap text-sm font-semibold leading-tight text-foreground">
                {getSessionTitle(selectedSession)}
              </h2>
              {selectedSession.__isArchived && (
                <ArchivedSessionControls sessionId={selectedSession.id} onRestoreSession={onRestoreSession} />
              )}
            </div>
            <div className="flex items-center justify-between gap-3">
              <span className="truncate text-[11px] leading-tight text-muted-foreground" title={pathLabel}>{pathLabel}</span>
              <RepoBranchBadge projectId={selectedProject.projectId} />
            </div>
          </div>
        ) : showChatNewSession ? (
          <div className="min-w-0">
            <h2 className="text-base font-semibold leading-tight text-foreground">{t('mainContent.newSession')}</h2>
            <div className="flex items-center justify-between gap-3">
              <span className="truncate text-xs leading-tight text-muted-foreground" title={pathLabel}>{pathLabel}</span>
              <RepoBranchBadge projectId={selectedProject.projectId} />
            </div>
          </div>
        ) : (
          <div className="min-w-0">
            <h2 className="text-sm font-semibold leading-tight text-foreground">
              {getTabTitle(activeTab, shouldShowTasksTab, t, pluginDisplayName)}
            </h2>
            <div className="flex items-center justify-between gap-3">
              <span className="truncate text-[11px] leading-tight text-muted-foreground" title={pathLabel}>{pathLabel}</span>
              <RepoBranchBadge projectId={selectedProject.projectId} />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

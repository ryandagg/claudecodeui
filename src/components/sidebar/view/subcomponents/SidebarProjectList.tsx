import { useEffect } from 'react';
import { ChevronDown, ChevronRight, Folder } from 'lucide-react';
import type { TFunction } from 'i18next';

import type { LoadingProgress, Project, ProjectSession, LLMProvider } from '../../../../types/app';
import type { SessionActivityMap } from '../../../../hooks/useSessionProtection';
import type { MCPServerStatus, SessionWithProvider } from '../../types/types';
import { groupProjectsByRepo, type RepoGroup } from '../../utils/utils';

import SidebarProjectItem from './SidebarProjectItem';
import SidebarProjectsState from './SidebarProjectsState';

/**
 * Section header for a repository group. "Always group" means every project
 * sits under one of these — a standalone repo is simply a group of one — so the
 * header is kept visually light (muted, uppercase) to read as a divider rather
 * than compete with the project rows beneath it. Clicking it collapses the group.
 */
function RepoGroupHeader({
  group,
  isCollapsed,
  onToggle,
}: {
  group: RepoGroup;
  isCollapsed: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      title={group.repoRoot}
      className="flex w-full items-center gap-1.5 rounded-md px-3 py-1.5 text-left transition-colors hover:bg-accent/50 md:px-1.5 md:py-1"
    >
      {isCollapsed ? (
        <ChevronRight className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
      ) : (
        <ChevronDown className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
      )}
      <Folder className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {group.repoName}
      </span>
      <span className="flex-shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
        {group.projects.length}
      </span>
    </button>
  );
}

export type SidebarProjectListProps = {
  projects: Project[];
  filteredProjects: Project[];
  selectedProject: Project | null;
  selectedSession: ProjectSession | null;
  isLoading: boolean;
  loadingProgress: LoadingProgress | null;
  expandedProjects: Set<string>;
  collapsedRepoGroups: Set<string>;
  onToggleRepoGroup: (repoRoot: string) => void;
  editingProject: string | null;
  editingName: string;
  initialSessionsLoaded: Set<string>;
  currentTime: Date;
  editingSession: string | null;
  editingSessionName: string;
  deletingProjects: Set<string>;
  tasksEnabled: boolean;
  mcpServerStatus: MCPServerStatus;
  getProjectSessions: (project: Project) => SessionWithProvider[];
  onLoadMoreSessions: (projectId: string) => void;
  loadingMoreProjects: Set<string>;
  activeSessions: SessionActivityMap;
  forceExpanded?: boolean;
  isProjectStarred: (projectName: string) => boolean;
  isSessionStarred: (session: SessionWithProvider) => boolean;
  onEditingNameChange: (value: string) => void;
  onToggleProject: (projectName: string) => void;
  onProjectSelect: (project: Project) => void;
  onToggleStarProject: (projectName: string) => void;
  onToggleStarSession: (session: SessionWithProvider) => void;
  onStartEditingProject: (project: Project) => void;
  onCancelEditingProject: () => void;
  onSaveProjectName: (projectName: string) => void;
  onDeleteProject: (project: Project) => void;
  onSessionSelect: (session: SessionWithProvider, projectName: string) => void;
  onDeleteSession: (
    projectName: string,
    sessionId: string,
    sessionTitle: string,
    provider: LLMProvider,
  ) => void;
  onNewSession: (project: Project) => void;
  onEditingSessionNameChange: (value: string) => void;
  onStartEditingSession: (sessionId: string, initialName: string) => void;
  onCancelEditingSession: () => void;
  onSaveEditingSession: (projectName: string, sessionId: string, summary: string, provider: LLMProvider) => void;
  t: TFunction;
};

export default function SidebarProjectList({
  projects,
  filteredProjects,
  selectedProject,
  selectedSession,
  isLoading,
  loadingProgress,
  expandedProjects,
  collapsedRepoGroups,
  onToggleRepoGroup,
  editingProject,
  editingName,
  initialSessionsLoaded,
  currentTime,
  editingSession,
  editingSessionName,
  deletingProjects,
  tasksEnabled,
  mcpServerStatus,
  getProjectSessions,
  onLoadMoreSessions,
  loadingMoreProjects,
  activeSessions,
  forceExpanded = false,
  isProjectStarred,
  isSessionStarred: _isSessionStarred,
  onEditingNameChange,
  onToggleProject,
  onProjectSelect,
  onToggleStarProject,
  onToggleStarSession: _onToggleStarSession,
  onStartEditingProject,
  onCancelEditingProject,
  onSaveProjectName,
  onDeleteProject,
  onSessionSelect,
  onDeleteSession,
  onNewSession,
  onEditingSessionNameChange,
  onStartEditingSession,
  onCancelEditingSession,
  onSaveEditingSession,
  t,
}: SidebarProjectListProps) {
  const state = (
    <SidebarProjectsState
      isLoading={isLoading}
      loadingProgress={loadingProgress}
      projectsCount={projects.length}
      filteredProjectsCount={filteredProjects.length}
      t={t}
    />
  );

  useEffect(() => {
    let baseTitle = 'Claude GUI';
    const displayName = selectedProject?.displayName?.trim();
    if (displayName) {
      baseTitle = `${displayName} - ${baseTitle}`;
    }
    document.title = baseTitle;
  }, [selectedProject]);

  const showProjects = !isLoading && projects.length > 0 && filteredProjects.length > 0;

  return (
    <div className="pb-safe-area-inset-bottom md:space-y-1">
      {!showProjects
        ? state
        : groupProjectsByRepo(filteredProjects).map((group) => {
            const isGroupCollapsed = collapsedRepoGroups.has(group.repoRoot);

            return (
              <div key={group.repoRoot} className="md:space-y-1">
                <RepoGroupHeader
                  group={group}
                  isCollapsed={isGroupCollapsed}
                  onToggle={() => onToggleRepoGroup(group.repoRoot)}
                />
                {!isGroupCollapsed && (
                  // Subtle nesting rail on desktop; mobile cards keep their own margins.
                  <div className="md:ml-3 md:border-l md:border-border/40 md:pl-1">
                    {group.projects.map((project) => (
                      // React key + per-project state lookups all use the DB `projectId`
                      // so they remain stable across renames and session changes.
                      <SidebarProjectItem
                        key={project.projectId}
                        project={project}
                        selectedProject={selectedProject}
                        selectedSession={selectedSession}
                        isExpanded={forceExpanded || expandedProjects.has(project.projectId)}
                        isDeleting={deletingProjects.has(project.projectId)}
                        isStarred={isProjectStarred(project.projectId)}
                        editingProject={editingProject}
                        editingName={editingName}
                        sessions={getProjectSessions(project)}
                        initialSessionsLoaded={initialSessionsLoaded.has(project.projectId)}
                        isLoadingMoreSessions={loadingMoreProjects.has(project.projectId)}
                        currentTime={currentTime}
                        editingSession={editingSession}
                        editingSessionName={editingSessionName}
                        tasksEnabled={tasksEnabled}
                        mcpServerStatus={mcpServerStatus}
                        onEditingNameChange={onEditingNameChange}
                        onToggleProject={onToggleProject}
                        onProjectSelect={onProjectSelect}
                        onToggleStarProject={onToggleStarProject}
                        onStartEditingProject={onStartEditingProject}
                        onCancelEditingProject={onCancelEditingProject}
                        onSaveProjectName={onSaveProjectName}
                        onDeleteProject={onDeleteProject}
                        onSessionSelect={onSessionSelect}
                        onDeleteSession={onDeleteSession}
                        onLoadMoreSessions={onLoadMoreSessions}
                        activeSessions={activeSessions}
                        onNewSession={onNewSession}
                        onEditingSessionNameChange={onEditingSessionNameChange}
                        onStartEditingSession={onStartEditingSession}
                        onCancelEditingSession={onCancelEditingSession}
                        onSaveEditingSession={onSaveEditingSession}
                        t={t}
                      />
                    ))}
                  </div>
                )}
              </div>
            );
          })}
    </div>
  );
}

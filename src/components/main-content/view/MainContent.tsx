import React, { useCallback, useRef } from 'react';

import ChatInterface from '../../chat/view/ChatInterface';
import FileTree from '../../file-tree/view/FileTree';
import StandaloneShell from '../../standalone-shell/view/StandaloneShell';
import GitPanel from '../../git-panel/view/GitPanel';
import PluginTabContent from '../../plugins/view/PluginTabContent';
import type { MainContentProps } from '../types/types';
import { usePaletteOpsRegister } from '../../../contexts/PaletteOpsContext';
import { useUiPreferences } from '../../../hooks/useUiPreferences';
import { useFileOpenResolver } from '../../../hooks/useFileOpenResolver';
import { api } from '../../../utils/api';
import { useEditorSidebar } from '../../code-editor/hooks/useEditorSidebar';
import EditorSidebar from '../../code-editor/view/EditorSidebar';

import MainContentHeader from './subcomponents/MainContentHeader';
import MainContentStateView from './subcomponents/MainContentStateView';
import ErrorBoundary from './ErrorBoundary';


function MainContent({
  selectedProject,
  selectedSession,
  activeTab,
  setActiveTab,
  ws,
  sendMessage,
  isMobile,
  onMenuClick,
  isLoading,
  onInputFocusChange,
  onSessionProcessing,
  onSessionIdle,
  processingSessions,
  onNavigateToSession,
  onSessionEstablished,
  onShowSettings,
  externalMessageUpdate,
  newSessionTrigger,
}: MainContentProps) {
  const { preferences } = useUiPreferences();
  const { autoExpandTools, showRawParameters, showThinking, autoScrollToBottom, sendByCtrlEnter } = preferences;


  const {
    editingFile,
    editorWidth,
    editorExpanded,
    hasManualWidth,
    resizeHandleRef,
    handleFileOpen,
    handleCloseEditor,
    handleToggleEditorExpand,
    handleResizeStart,
  } = useEditorSidebar({
    selectedProject,
    isMobile,
  });

  // Resolves bare/partial file references (e.g. links inside chat messages) to
  // real project files before opening them in the in-app editor.
  const resolvedFileOpen = useFileOpenResolver(selectedProject, handleFileOpen);

  // The browser can't expand `~` (it doesn't know $HOME), so we fetch the
  // server's home directory once and cache it to rewrite `~/...` refs to
  // absolute paths before building a `vscode://file/...` URI.
  const homedirRef = useRef<string | null>(null);
  const homedirPromiseRef = useRef<Promise<string | null> | null>(null);
  const loadHomedir = useCallback((): Promise<string | null> => {
    if (homedirRef.current !== null) return Promise.resolve(homedirRef.current);
    if (!homedirPromiseRef.current) {
      homedirPromiseRef.current = (async () => {
        try {
          const response = await api.systemHome();
          if (!response.ok) return null;
          const data = await response.json();
          const home = typeof data?.homedir === 'string' ? data.homedir.replace(/\/+$/, '') : null;
          homedirRef.current = home;
          return home;
        } catch {
          return null;
        }
      })();
    }
    return homedirPromiseRef.current;
  }, []);

  // Hands the OS a `vscode://file/<abspath>[:line]` URI, which it routes to VS
  // Code. `encodeURI` keeps `/` and `:` intact while escaping spaces etc.
  const openAbsoluteInVSCode = useCallback((absolutePath: string, line?: number) => {
    const suffix = typeof line === 'number' && line > 0 ? `:${line}` : '';
    const uri = `vscode://file${encodeURI(absolutePath)}${suffix}`;
    const anchor = document.createElement('a');
    anchor.href = uri;
    anchor.style.display = 'none';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  }, []);

  // ⌘/Ctrl-click on an in-chat file link opens it in VS Code. Bare/partial refs
  // (`foo.ts`, `utils/foo.ts`) still resolve against the project file tree to an
  // absolute path first; absolute refs skip that fetch (handled below).
  const openResolvedInVSCode = useFileOpenResolver(
    selectedProject,
    useCallback((absolutePath: string, line?: number) => openAbsoluteInVSCode(absolutePath, line), [openAbsoluteInVSCode]),
  );


  usePaletteOpsRegister({
    openFile: (filePath: string) => {
      setActiveTab('files');
      handleFileOpen(filePath);
    },
    // Opens the editor side panel in place, keeping the current tab (e.g. chat).
    openFileInEditor: (filePath: string) => {
      resolvedFileOpen(filePath);
    },
    // Opens the file in VS Code (⌘/Ctrl-click on an in-chat link). Split off any
    // `:line[:col]` suffix, then open. Absolute paths (the common form Claude
    // emits) open immediately; `~/...` refs expand against the server's home dir;
    // bare/partial refs resolve against the file tree so `vscode://file/...`
    // always gets an absolute path.
    openFileInVSCode: (filePath: string) => {
      const match = filePath.match(/:(\d+)(?::\d+)?$/);
      const line = match ? Number(match[1]) : undefined;
      const bareRef = match ? filePath.slice(0, match.index) : filePath;
      if (bareRef === '~' || bareRef.startsWith('~/')) {
        void loadHomedir().then((home) => {
          if (!home) return;
          const expanded = bareRef === '~' ? home : `${home}/${bareRef.slice(2)}`;
          openAbsoluteInVSCode(expanded, line);
        });
      } else if (bareRef.startsWith('/') || /^[A-Za-z]:[\\/]/.test(bareRef)) {
        openAbsoluteInVSCode(bareRef, line);
      } else {
        openResolvedInVSCode(bareRef, line);
      }
    },
  });

  if (isLoading) {
    return <MainContentStateView mode="loading" isMobile={isMobile} onMenuClick={onMenuClick} />;
  }

  if (!selectedProject) {
    return <MainContentStateView mode="empty" isMobile={isMobile} onMenuClick={onMenuClick} />;
  }

  return (
    <div className="flex h-full flex-col">
      <MainContentHeader
        activeTab={activeTab}
        setActiveTab={setActiveTab}
        selectedProject={selectedProject}
        selectedSession={selectedSession}
        shouldShowTasksTab={false}
        shouldShowBrowserTab={false}
        isMobile={isMobile}
        onMenuClick={onMenuClick}
      />

      <div className="flex min-h-0 flex-1 overflow-hidden">
        <div className={`flex min-h-0 min-w-[200px] flex-col overflow-hidden ${editorExpanded ? 'hidden' : ''} flex-1`}>
          <div className={`h-full ${activeTab === 'chat' ? 'block' : 'hidden'}`}>
            <ErrorBoundary showDetails>
              <ChatInterface
                selectedProject={selectedProject}
                selectedSession={selectedSession}
                ws={ws}
                sendMessage={sendMessage}
                onFileOpen={handleFileOpen}
                onInputFocusChange={onInputFocusChange}
                onSessionProcessing={onSessionProcessing}
                onSessionIdle={onSessionIdle}
                processingSessions={processingSessions}
                onNavigateToSession={onNavigateToSession}
                onSessionEstablished={onSessionEstablished}
                onShowSettings={onShowSettings}
                autoExpandTools={autoExpandTools}
                showRawParameters={showRawParameters}
                showThinking={showThinking}
                autoScrollToBottom={autoScrollToBottom}
                sendByCtrlEnter={sendByCtrlEnter}
                externalMessageUpdate={externalMessageUpdate}
                newSessionTrigger={newSessionTrigger}
                onShowAllTasks={null}
              />
            </ErrorBoundary>
          </div>

          {activeTab === 'files' && (
            <div className="h-full overflow-hidden">
              <FileTree selectedProject={selectedProject} onFileOpen={handleFileOpen} />
            </div>
          )}

          {activeTab === 'shell' && (
            <div className="h-full w-full overflow-hidden">
              <StandaloneShell
                project={selectedProject}
                session={selectedSession}
                showHeader={false}
                isActive={activeTab === 'shell'}
              />
            </div>
          )}

          {activeTab === 'git' && (
            <div className="h-full overflow-hidden">
              <GitPanel selectedProject={selectedProject} isMobile={isMobile} onFileOpen={handleFileOpen} />
            </div>
          )}


          {activeTab.startsWith('plugin:') && (
            <div className="h-full overflow-hidden">
              <PluginTabContent
                pluginName={activeTab.replace('plugin:', '')}
                selectedProject={selectedProject}
                selectedSession={selectedSession}
              />
            </div>
          )}
        </div>

        <EditorSidebar
          editingFile={editingFile}
          isMobile={isMobile}
          editorExpanded={editorExpanded}
          editorWidth={editorWidth}
          hasManualWidth={hasManualWidth}
          resizeHandleRef={resizeHandleRef}
          onResizeStart={handleResizeStart}
          onCloseEditor={handleCloseEditor}
          onToggleEditorExpand={handleToggleEditorExpand}
          projectPath={selectedProject.path}
          fillSpace={activeTab === 'files'}
        />
      </div>
    </div>
  );
}

export default React.memo(MainContent);

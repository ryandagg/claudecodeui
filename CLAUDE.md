# CloudCLI Fork — Local Bedrock Bridge

## Dev Server Stability — Worktree Protocol

Ryan runs his dev server on the ports specified in the `dev:human-user` package.json script and runs from the branch checked out at ~/Documents/repos/claudecodeui/.
Never edit source files here directly during implementation — broken intermediate states kill HMR and the server process.

### Starting any code change

**Before creating a worktree**, check for existing ones:

```sh
git worktree list
```

If worktrees exist beyond the main one, ask the user:
- "There's an existing worktree at `<path>` on branch `<branch>`. Would you like to finish that work first, or remove it?"

Only proceed after the user decides. To remove a stale worktree:
```sh
git worktree remove <path>
git branch -D <branch>  # only if the user confirms deletion
```

### Implementation flow

1. **Create a worktree** (skip if this session already started in one):
   ```sh
   git worktree add ../worktrees/<short-slug> -b feat/<short-slug> main
   ```
2. **Develop plan before implementation. Analyze code. Verify assumptions**
3. **Implement**
4. **Verify feature via browser quality assurance**
   Develop a QA plan and debug. Fix findings.
   Use the user's running dev server (ports dynamically chosen and reported in shell) or start one from the worktree. Use the chrome-devtools MCP to open the URL from the dev server output and verify:
   - The golden path works
   - Edge cases behave correctly
   - No regressions in surrounding features

   A change that compiles but wasn't browser-verified is not complete. This applies to **all changes**, including bulk removals and refactors — deleted modules leave dangling references in files that tsc may not catch (JS configs, dynamic imports, i18n registrations). The browser is the final arbiter.
5. Ensure code quality:
   ```sh
   npm run lint && npm run typecheck
   ```
   Both must pass. Do NOT skip lint — deleted files leave dangling imports that tsc misses but Vite catches at runtime.
6. **Verify with Ryan**
   Provide URL to running app and QA plan from prior step. Get approval for next steps.
7. **Merge to main** (from the main worktree):
   ```sh
   cd /Users/rdagg/Documents/repos/claudecodeui
   git merge feat/<short-slug> --ff-only
   ```
   If fast-forward fails (main moved): rebase the feature branch in the worktree first.
8. **Clean up:**
   ```sh
   git worktree remove ../worktrees/<short-slug>
   git branch -d feat/<short-slug>
   ```

### Multiple sessions working concurrently
- Each session uses a **unique branch + worktree** (e.g. `../worktrees/reactions`, `../worktrees/sidebar-fix`).
- Merges to main happen one at a time. If main moved, rebase before merging.
- The dev server picks up changes naturally on merge (tsx watches `server/`, Vite HMRs frontend).
- dev server ports are now handled via script. Check logs after any server restart for URL.

### Edge case: already editing in main worktree

- If you realize mid-edit that you're in main: `git stash -u`, create the worktree, `git stash pop` inside it, continue there.
- If the edit is done and compiles cleanly: commit directly (no worktree needed for a completed atomic change).

## Architecture

- Auth neutralized (local fork, Bedrock env inherited from shell)
- SQLite via `better-sqlite3`, schema in `server/modules/database/schema.ts`
- Routes: `server/routes/*.js` (Express routers), registered in `server/index.js`

## Conventions

- Server routes use relative imports (`'../modules/database/index.js'`)
- Repository pattern: one file per entity in `server/modules/database/repositories/`
- Client API calls via `src/utils/api.js` using `authenticatedFetch`
- TypeScript strict, no build errors tolerated before merge

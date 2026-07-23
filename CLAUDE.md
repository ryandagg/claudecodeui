# CloudCLI Fork — Local Bedrock Bridge

## Dev Server Stability — Worktree Protocol

The dev server (Vite `:5173` + tsx `:3021`) runs from the **main worktree** at this repo root.
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

1. **Create a worktree:**
   ```sh
   git worktree add /tmp/ccui-<short-slug> -b feat/<short-slug> main
   ```
2. **Do all work** in `/tmp/ccui-<short-slug>`. Verify before merging:
   ```sh
   npm run lint && npm run typecheck
   ```
   Both must pass. Do NOT skip lint — deleted files leave dangling imports that tsc misses but Vite catches at runtime.
3. **Merge to main** (from the main worktree):
   ```sh
   cd /Users/rdagg/Documents/repos/claudecodeui
   git merge feat/<short-slug> --ff-only
   ```
   If fast-forward fails (main moved): rebase the feature branch in the worktree first.
4. **Clean up:**
   ```sh
   git worktree remove /tmp/ccui-<short-slug>
   git branch -d feat/<short-slug>
   ```

### Multiple sessions working concurrently
- Each session uses a **unique branch + worktree** (e.g. `/tmp/ccui-reactions`, `/tmp/ccui-sidebar-fix`).
- Merges to main happen one at a time. If main moved, rebase before merging.
- The dev server picks up changes naturally on merge (tsx watches `server/`, Vite HMRs frontend).
- dev server ports are now handled via script. Check logs after any server restart for URL.

### Verification — no change is done until tested in a browser

After lint + typecheck pass, use the user's running dev server (default ports `:3001`/`:5173`) or start one from the worktree on those ports. Use chrome-devtools MCP to open `http://localhost:5173` and verify:
- The golden path works
- Edge cases behave correctly
- No regressions in surrounding features

A change that compiles but wasn't browser-verified is not complete. This applies to **all changes**, including bulk removals and refactors — deleted modules leave dangling references in files that tsc may not catch (JS configs, dynamic imports, i18n registrations). The browser is the final arbiter.

### Edge case: already editing in main worktree

- If you realize mid-edit that you're in main: `git stash -u`, create the worktree, `git stash pop` inside it, continue there.
- If the edit is done and compiles cleanly: commit directly (no worktree needed for a completed atomic change).

## Architecture

- Vite client at `:5173` with HMR, tsx server at `:3021`
- Auth neutralized (local fork, Bedrock env inherited from shell)
- SQLite via `better-sqlite3`, schema in `server/modules/database/schema.ts`
- Routes: `server/routes/*.js` (Express routers), registered in `server/index.js`

## Conventions

- Server routes use relative imports (`'../modules/database/index.js'`)
- Repository pattern: one file per entity in `server/modules/database/repositories/`
- Client API calls via `src/utils/api.js` using `authenticatedFetch`
- TypeScript strict, no build errors tolerated before merge

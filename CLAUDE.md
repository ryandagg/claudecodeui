# CloudCLI Fork — Local Bedrock Bridge

## Dev Server Stability — Worktree Protocol

Humans run their dev server on the ports specified in the `dev:human-user` package.json script and runs from the branch checked out at ~/Documents/repos/claudecodeui/.
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
   Write or update tests as you go — for pure logic (server + frontend utils) and DB repositories, the test suite is the fast inner loop. Run `npm run test:watch` or `npm test -- <path>` against the module you're touching before reaching for the browser. New behavior in a tested module means a new test in the same change. See **Testing** below.
4. **Verify feature via browser quality assurance**
   Develop a QA plan and debug. Fix findings.
   Use `npm run dev`  (ports dynamically chosen and reported in shell) from the worktree. Use the chrome-devtools MCP to open the URL from the dev server output and verify:
   - The golden path works
   - Edge cases behave correctly
   - No regressions in surrounding features

   A change that compiles but wasn't browser-verified is not complete. This applies to **all changes**, including bulk removals and refactors — deleted modules leave dangling references in files that tsc may not catch (JS configs, dynamic imports, i18n registrations). The browser is the final arbiter.
5. Ensure code quality:
   ```sh
   npm test && npm run lint && npm run typecheck
   ```
   All three must pass. Do NOT skip lint — deleted files leave dangling imports that tsc misses but Vite catches at runtime. `npm test` is fast (no browser, no server) and catches logic regressions the browser pass may not exercise; it is a required gate, not optional. tsx erases types at runtime, so a test can pass while typecheck still fails on it — that's why all three run.
6. **Verify with User**
   Provide URL to running app and QA plan from prior step. Get approval for next steps.
7. **Push & open a PR** (from the worktree):
   ```sh
   git push -u origin feat/<short-slug>
   gh pr create --base main --fill
   ```
   If `main` moved since you branched, rebase before pushing:
   ```sh
   git fetch origin && git rebase origin/main
   ```
   CI runs lint, typecheck, and tests on the PR (`.github/workflows/ci.yml`) — the change isn't done until those checks are green. A human reviews and merges the PR; don't merge to `main` yourself.
8. **Clean up** (once the PR has merged):
   ```sh
   cd /Users/rdagg/Documents/repos/claudecodeui
   git worktree remove ../worktrees/<short-slug>
   git branch -D feat/<short-slug>   # merged on GitHub, so the local branch won't show as merged to git
   ```

### Multiple sessions working concurrently
- Each session uses a **unique branch + worktree** (e.g. `../worktrees/reactions`, `../worktrees/sidebar-fix`).
- Each session opens its own PR. If `main` moved, rebase the feature branch on `origin/main` before pushing. A human merges the PRs one at a time.
- Once a PR merges into the branch the human runs, the dev server picks up the changes (tsx watches `server/`, Vite HMRs frontend).
- dev server ports are now handled via script. Check logs after any server restart for URL.

### Edge case: already editing in main worktree

- If you realize mid-edit that you're in main: `git stash -u`, create the worktree, `git stash pop` inside it, continue there.
- If the edit is done and compiles cleanly: branch, commit, and push + open a PR directly — no worktree needed for a completed atomic change. Still don't merge to `main` yourself; let the PR be the path in.

## Architecture

- Auth neutralized (local fork, Bedrock env inherited from shell)
- SQLite via `better-sqlite3`, schema in `server/modules/database/schema.ts`
- Routes: `server/routes/*.js` (Express routers), registered in `server/index.js`

## Testing

The suite uses Node's built-in runner (`node:test` + `node:assert/strict`) executed through `tsx` — **there is no jest/vitest**, so don't add one or reach for its APIs. `scripts/run-tests.js` discovers every `*.test.{ts,tsx,js}` under `server/`, `src/`, and `shared/` and runs them.

```sh
npm test                 # full suite (fast — no browser, no dev server)
npm run test:coverage    # same, with V8 line/branch/function coverage
npm run test:watch       # re-run on change; the inner loop while implementing
npm test -- <path>       # limit to matching files while iterating
```

- **Colocate** tests in a `tests/` dir beside the code (`server/**/tests/`, `src/components/**/`). Server tests import via the `@/*` alias; frontend tests use relative imports.
- **What to test:** pure logic (server + frontend `utils`) and DB repositories are the high-value, low-cost targets and should stay covered.
- **DB integration tests** run against a real temp-file SQLite DB with the real schema and `PRAGMA foreign_keys = ON`. Use the shared `server/modules/database/tests/helpers.ts` (`withIsolatedDatabase`, `seedUser`) — any table with a `user_id` FK needs a seeded user first. Note SQLite `CURRENT_TIMESTAMP` is second-granular, so force explicit timestamps when asserting recency ordering.
- Browser QA (step 4) and the test suite are complementary, not substitutes: tests cover logic and data paths headlessly; the browser covers rendering, wiring, and dangling references tsc misses.

## Conventions

- Server routes use relative imports (`'../modules/database/index.js'`)
- Repository pattern: one file per entity in `server/modules/database/repositories/`
- Client API calls via `src/utils/api.js` using `authenticatedFetch`
- TypeScript strict, no build errors tolerated before opening a PR
- Tests via `node:test` + `tsx` (no jest/vitest); colocated in `tests/` dirs. `npm test` is part of the pre-PR gate that CI enforces on every pull request — see **Testing**
- **Claude *config* lives in `~/.claude/settings.json` — the app never mirrors it.** Config is the global default the terminal `claude` reads too: `model`, `permissions`, `hooks`, `env`. The Agent SDK enforces it via `settingSources`, so a parallel in-app copy is silently ignored and drifts. App-only UX (theme, notifications, editor prefs) stays in the app's DB.
- **Per-session choices are *session state*, and the app owns them.** settings.json has no per-session concept, so a session-scoped model, permission mode, or cwd has nothing to duplicate. The SDK keeps these in process memory only — `/model` says "for this session only" and dies with the subprocess, and this app spawns a fresh `query({resume})` per message — so app-side persistence (`~/.cloudcli/provider-session-active-model-changes.json`) is required, not redundant.
- **Deciding which you have: does settings.json own a key for this axis?** Yes → config, read it there. No → session state, the app store is the source of truth, layered at resolve time (session override → explicit request → omit and let settings.json answer).

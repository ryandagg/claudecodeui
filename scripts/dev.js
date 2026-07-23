// Dev launcher: derive non-colliding ports per git worktree, then run the
// server + client together with fate-sharing on failure.
//
// WHY THIS EXISTS
//   Multiple agents run `npm run dev` from separate worktrees at once. `.env` is
//   gitignored, so every fresh worktree fell back to the SAME default ports
//   (3001/5173) and they fought over them ("robots fighting robots, killing
//   ports"). Killing the port-holder just killed another agent's server.
//
// WHAT THIS DOES
//   1. Picks a BASE port from the shell env (wins) → .env → built-in default.
//   2. Adds a deterministic OFFSET derived from the worktree's identity, so each
//      worktree gets a stable pair that survives restarts. The MAIN worktree gets
//      offset 0, so Ryan's pinned .env ports (3021/5173) are unchanged.
//   3. Probes upward from that pair for the first PAIR where BOTH ports are free,
//      so hash collisions between worktrees resolve automatically instead of
//      cascading into EADDRINUSE.
//   4. Exports the chosen ports into process.env — inherited by both children.
//      `server/load-env.js` and Vite's `loadEnv('')` both defer to an existing
//      process.env value, so this is the single source of truth for the run.
//   5. Runs server + client via concurrently with `killOthers: ['failure']`: if
//      one child EXITS NON-ZERO (EADDRINUSE, a TS crash), its sibling is torn
//      down too — so a half-failed launch can't leave Vite up with a dead backend
//      ("Offline"). A clean Ctrl-C shutdown does NOT trigger it.
//
// The BASE port comes from shell env / .env / default, but the offset + probe
// ALWAYS run on top of it — because Ryan's shell profile exports SERVER_PORT/
// VITE_PORT, so every worktree agent inherits identical pins; honoring those as
// exact demands is what caused the collisions. To force an exact, un-offset,
// un-probed port pass `--exact`: `SERVER_PORT=8080 VITE_PORT=8081 npm run dev -- --exact`.

import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import concurrently from 'concurrently';

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const noWatch = process.argv.includes('--no-watch');

// --- base ports: shell env wins, then .env, then built-in default ---------
function readEnvFile() {
  try {
    const raw = fs.readFileSync(path.join(APP_ROOT, '.env'), 'utf8');
    const out = {};
    for (const line of raw.split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const [key, ...rest] = t.split('=');
      if (key && rest.length) out[key.trim()] = rest.join('=').trim();
    }
    return out;
  } catch {
    return {};
  }
}

const dotenv = readEnvFile();

// BASE ports: shell env wins, then .env, then built-in default. NOTE: the base
// is only a STARTING POINT — the worktree offset and free-port probe always run
// on top of it. This is deliberate: Ryan's shell exports SERVER_PORT/VITE_PORT
// from his profile, so every worktree agent inherits IDENTICAL pinned ports.
// Treating those as "the exact port I demand" would defeat per-worktree
// isolation (the original robot-party bug). If you truly need an exact,
// un-offset, un-probed port, pass `--exact`.
const exact = process.argv.includes('--exact');
const baseServer = Number(
  process.env.SERVER_PORT || process.env.PORT || dotenv.SERVER_PORT || dotenv.PORT || 3001,
);
const baseVite = Number(process.env.VITE_PORT || dotenv.VITE_PORT || 5173);

// --- deterministic per-worktree offset ------------------------------------
// Main worktree → offset 0 (keeps the base ports stable). Linked worktrees hash
// their own git dir to a stable [1..40] offset, so each worktree lands on its
// own reproducible pair that survives restarts.
function worktreeOffset() {
  try {
    const opts = { cwd: APP_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] };
    const gitDir = execFileSync('git', ['rev-parse', '--absolute-git-dir'], opts).trim();
    const commonDir = execFileSync('git', ['rev-parse', '--git-common-dir'], opts).trim();
    // In the main worktree these resolve to the same path.
    if (path.resolve(APP_ROOT, gitDir) === path.resolve(APP_ROOT, commonDir)) return 0;
    const hash = crypto.createHash('sha1').update(gitDir).digest();
    return 1 + (hash.readUInt16BE(0) % 40);
  } catch {
    return 0; // not a git checkout — behave like main
  }
}

const offset = exact ? 0 : worktreeOffset();

// --- probe upward for the first pair where BOTH ports are free ------------
function portFree(port) {
  return new Promise((resolve) => {
    const tester = net
      .createServer()
      .once('error', () => resolve(false))
      .once('listening', () => tester.close(() => resolve(true)))
      .listen(port, '0.0.0.0');
  });
}

async function pickFreePair(startServer, startVite) {
  // `--exact` honors the requested ports without hunting; otherwise probe up to
  // 50 pairs to skip past ports held by other worktrees.
  const maxSteps = exact ? 1 : 50;
  for (let i = 0; i < maxSteps; i++) {
    const s = startServer + i;
    const v = startVite + i;
    if ((await portFree(s)) && (await portFree(v))) return { server: s, vite: v };
  }
  return null;
}

const start = { server: baseServer + offset, vite: baseVite + offset };
const pair = await pickFreePair(start.server, start.vite);

if (!pair) {
  console.error(
    `\x1b[31m✗ dev: no free SERVER_PORT/VITE_PORT pair found near ${start.server}/${start.vite}.\x1b[0m\n` +
      `  Another dev server likely owns these. Pick a free pair explicitly, e.g.\n` +
      `  \x1b[36mSERVER_PORT=8080 VITE_PORT=8081 npm run dev\x1b[0m  — do NOT kill the other process.`,
  );
  process.exit(1);
}

process.env.SERVER_PORT = String(pair.server);
process.env.VITE_PORT = String(pair.vite);

const label = offset === 0 ? '' : ` \x1b[2m(worktree offset +${offset})\x1b[0m`;
console.log(
  `\x1b[32m✓ dev: SERVER_PORT=${pair.server}  VITE_PORT=${pair.vite}\x1b[0m${label}\n` +
    `  UI (HMR): \x1b[36mhttp://localhost:${pair.vite}\x1b[0m`,
);

// --- run server + client; tear both down if one FAILS ---------------------
const serverScript = noWatch ? 'server:dev' : 'server:dev-watch';
const { result } = concurrently(
  [
    { command: `npm run ${serverScript}`, name: 'server', prefixColor: 'blue' },
    { command: 'npm run client', name: 'client', prefixColor: 'magenta' },
  ],
  {
    killOthers: ['failure'],
    prefixColor: 'auto',
  },
);

result.then(
  () => process.exit(0),
  () => process.exit(1),
);

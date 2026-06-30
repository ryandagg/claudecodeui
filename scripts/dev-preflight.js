// Dev preflight: catch the two traps that turn a simple "stale process" into a
// confusing "search is broken / Offline" debugging session.
//
//   1. An OLD backend is still holding SERVER_PORT. `npm run dev` would then hit
//      EADDRINUSE, and `concurrently --kill-others` would tear Vite down too.
//   2. A backend is healthy on the port but it's a STALE build (no watch on the
//      classic server:dev), so recent server edits (e.g. the auth bypass) aren't
//      actually loaded. We can't detect "stale" precisely, but we can surface
//      whoever owns the port so the human decides.
//
// This runs as `predev`. It never blocks startup on its own — it prints a clear,
// actionable message and exits non-zero ONLY when the port is already taken, so
// the cascade failure is replaced by one obvious line.

import net from 'node:net';
import { execSync } from 'node:child_process';

const PORT = Number(process.env.SERVER_PORT || process.env.PORT || 3001);

function whoOwns(port) {
  try {
    // macOS/Linux lsof; best-effort, purely informational.
    const out = execSync(`lsof -nP -iTCP:${port} -sTCP:LISTEN`, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return out || null;
  } catch {
    return null;
  }
}

function portInUse(port) {
  return new Promise((resolve) => {
    const tester = net
      .createServer()
      .once('error', (err) => resolve(err.code === 'EADDRINUSE'))
      .once('listening', () => tester.close(() => resolve(false)))
      .listen(port, '0.0.0.0');
  });
}

const inUse = await portInUse(PORT);

if (inUse) {
  const owner = whoOwns(PORT);
  console.error(
    [
      '',
      `\x1b[31m✗ Dev preflight: port ${PORT} is already in use.\x1b[0m`,
      '',
      'A backend is already bound to this port. Starting `npm run dev` now would',
      'fail with EADDRINUSE and `--kill-others` would also stop Vite, leaving the',
      'app "Offline". Pick one:',
      '',
      `  • Reuse the running backend — just start the client:  \x1b[36mnpm run client\x1b[0m`,
      `  • Replace it — stop the old process, then re-run dev:  \x1b[36mkill <PID> && npm run dev\x1b[0m`,
      '',
      owner ? `Current listener on :${PORT}:\n${owner}` : `(install lsof to see which PID owns :${PORT})`,
      '',
    ].join('\n'),
  );
  process.exit(1);
}

console.log(`\x1b[32m✓ Dev preflight: port ${PORT} is free.\x1b[0m`);

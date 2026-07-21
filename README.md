# Claude GUI

A local web UI for Claude Code sessions that passes through to your existing Bedrock authentication. Browse, search, and interact with all your Claude Code sessions from a browser instead of the terminal.

Built on [CloudCLI UI](https://github.com/siteboon/claudecodeui), licensed AGPL-3.0.

## Prerequisites

- **Node.js 20+** (for tsx and better-sqlite3 native addon)
- **Claude Code installed** (`claude` CLI available in PATH)
- **Bedrock environment configured** in your shell (the server inherits env vars at startup):
  ```sh
  export CLAUDE_CODE_USE_BEDROCK=1
  export CLAUDE_CODE_SKIP_BEDROCK_AUTH=1
  export ANTHROPIC_BEDROCK_BASE_URL=<your-proxy-url>
  # ... any other Bedrock/proxy vars your team uses
  ```

## Quick Start

```sh
# Clone and install
git clone https://github.com/nicandgus/claude-gui.git
cd claude-gui
npm install

# Start dev server (from a shell with Bedrock env vars set)
npm run dev
```

Open **http://localhost:5173** — you'll land directly in the UI with your existing sessions loaded.

## How It Works

The server is a thin bridge: it spawns Claude Code SDK processes that inherit your shell's Bedrock environment. There is no separate authentication — if `claude` works in your terminal, this works too.

- **No login/onboarding** — auth gates are short-circuited for local use
- **No git config writes** — the app never touches your git identity
- **Session history** — synced from `~/.claude/projects/` on startup
- **Full-text search** — search across all your session transcripts
- **Push notifications** — get notified when long-running sessions complete
- **Mobile-friendly** — install as a PWA on your phone for on-the-go monitoring

## Configuration

| Env Var | Default | Description |
|---------|---------|-------------|
| `SERVER_PORT` | `3001` | Backend API server port |
| `VITE_PORT` | `5173` | Frontend dev server port |
| `DATABASE_PATH` | `~/.claude-gui/auth.db` | SQLite database location |

All Claude-specific configuration (model, permissions, hooks, MCP servers) is read from your standard `~/.claude/settings.json` and project-level `CLAUDE.md` files — the same files the terminal `claude` CLI uses.

## Gotchas

- **Must launch from a Bedrock-configured shell.** The server reads env vars once at startup. If you open a new terminal without the Bedrock exports, `npm run dev` will start but Claude calls will fail.
- **First startup takes a moment** while it scans `~/.claude/projects/` to index your sessions into SQLite.
- **Ports 3001 + 5173 must be free** (or override with env vars above).
- **The SQLite DB is local to this machine.** Session history is read from your `~/.claude` directory; the DB is just an index/cache.

## License

AGPL-3.0 — see [LICENSE](./LICENSE) for full terms including attribution requirements.

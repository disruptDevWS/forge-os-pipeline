# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Quick Context

NanoClaw is a personal Claude assistant. Single Node.js process connects to WhatsApp, routes messages to Claude Agent SDK running in containers (Apple Container on macOS, Docker on Linux). Each WhatsApp group gets an isolated container with its own filesystem and memory.

See [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md) for architecture decisions and [docs/SECURITY.md](docs/SECURITY.md) for the trust model.

**Before modifying pipeline code**, read [docs/PIPELINE.md](docs/PIPELINE.md) (authoritative phase contract — who owns what data) and [docs/DECISIONS.md](docs/DECISIONS.md) (why non-obvious choices were made). If a phase responsibility changes, update PIPELINE.md in the same commit.

## Development Commands

```bash
npm run dev              # Run with hot reload (tsx)
npm run build            # Compile TypeScript (tsc)
npm run typecheck        # Type-check without emitting (tsc --noEmit)
npm run format           # Format with prettier
npm run format:check     # Check formatting
npm test                 # Run all tests (vitest run)
npm run test:watch       # Watch mode
npx vitest run src/db.test.ts  # Run a single test file
./container/build.sh     # Rebuild agent container image
```

Run commands directly — don't tell the user to run them.

macOS service management:
```bash
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist
```

## Skills

| Skill | When to Use |
|-------|-------------|
| `/setup` | First-time installation, authentication, service configuration |
| `/customize` | Adding channels, integrations, changing behavior |
| `/debug` | Container issues, logs, troubleshooting |

## Architecture

```
WhatsApp (baileys) → SQLite → Polling loop (2s) → GroupQueue → Container (Claude Agent SDK) → Response
                                                                    ↕
                                                              IPC (filesystem)
```

### Message Flow

1. **Inbound**: `WhatsAppChannel` receives messages via baileys, stores in SQLite (`messages` table).
2. **Poll loop** (`src/index.ts`): Every 2s, queries for new messages across registered groups. Checks trigger pattern (`@Andy` by default). Groups messages by `chat_jid`.
3. **Queue** (`src/group-queue.ts`): Enforces one container per group, max 5 concurrent containers total. Tasks are prioritized over messages. Exponential retry backoff (5s base, max 5 retries).
4. **Container spawn** (`src/container-runner.ts`): Builds volume mounts, spawns container process, passes secrets via stdin (never env vars or disk). Streams output via sentinel markers (`---NANOCLAW_OUTPUT_START---`/`---NANOCLAW_OUTPUT_END---`).
5. **Agent execution** (`container/agent-runner/src/index.ts`): Runs Claude Agent SDK `query()` with `MessageStream` (async iterable) to support multi-turn and agent teams. Polls IPC input directory for follow-up messages during execution.
6. **Outbound**: Agent writes IPC files → host IPC watcher routes to WhatsApp. `<internal>…</internal>` blocks are stripped before sending.

### IPC Model

File-based IPC via `data/ipc/{groupFolder}/` mounted as `/workspace/ipc/` in the container:

- **Container → Host**: `messages/` (send_message) and `tasks/` (schedule/pause/resume/cancel tasks, register groups)
- **Host → Container**: `input/` (follow-up messages) and `input/_close` (graceful shutdown sentinel)
- MCP server (`ipc-mcp-stdio.ts`) exposes tools: `send_message`, `schedule_task`, `list_tasks`, `pause_task`, `resume_task`, `cancel_task`, `register_group`
- IPC watcher (`src/ipc.ts`) enforces authorization: non-main groups can only message/schedule for themselves; main group has cross-group access

### Container Lifecycle

- Agent-runner TypeScript is **recompiled on every container start** from the host-mounted source (`container/agent-runner/src/`). This bypasses the build cache so code changes take effect without rebuilding the image.
- Credentials (`CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY`) are read from `.env` by `container-runner.ts` and passed as JSON via stdin. They are never written to disk inside the container.
- The `_close` sentinel is the clean shutdown path: `GroupQueue.closeStdin()` writes it after idle timeout; agent-runner exits gracefully.
- Session resumption uses `resumeAt` (UUID of last assistant message) so follow-up queries pick up where the previous one ended.

### Container Mounts

| Container Path | Host Source | Access |
|----------------|------------|--------|
| `/workspace/group` | `groups/{folder}/` | RW |
| `/workspace/global` | `groups/global/` (non-main only) | RO |
| `/workspace/project` | project root (main only) | RW |
| `/home/node/.claude` | `data/sessions/{folder}/.claude/` | RW |
| `/workspace/ipc` | `data/ipc/{folder}/` | RW |
| `/app/src` | `container/agent-runner/src/` | RO |
| `/workspace/extra/{name}` | additional mounts (allowlist-validated) | configurable |

Mount security: additional mounts are validated against `~/.config/nanoclaw/mount-allowlist.json` (`src/mount-security.ts`).

## Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Orchestrator: state, message loop, agent invocation |
| `src/channels/whatsapp.ts` | WhatsApp connection, auth, send/receive |
| `src/ipc.ts` | IPC watcher and task authorization |
| `src/router.ts` | Message formatting (`escapeXml`, XML wrapping) and outbound routing |
| `src/config.ts` | Trigger pattern, paths, intervals, env-configurable values |
| `src/container-runner.ts` | Container spawn, volume mounts, streaming output parser |
| `src/group-queue.ts` | Per-group queue with global concurrency limit |
| `src/task-scheduler.ts` | Cron/interval/once scheduled tasks |
| `src/mount-security.ts` | Allowlist-based mount path validation |
| `src/db.ts` | SQLite operations (messages, groups, sessions, tasks, state) |
| `src/env.ts` | `.env` file parser (never touches `process.env`) |
| `src/types.ts` | All TypeScript interfaces (`Channel`, `RegisteredGroup`, etc.) |
| `container/agent-runner/src/index.ts` | In-container SDK query loop, MessageStream, IPC polling |
| `container/agent-runner/src/ipc-mcp-stdio.ts` | MCP server exposing IPC tools to the agent |
| `container/Dockerfile` | node:22-slim + Chromium + claude-code |
| `scripts/pipeline-generate.ts` | Audit pipeline: all agent generation phases (Dwight, Jim, etc.) |
| `scripts/anthropic-client.ts` | Anthropic SDK wrapper — drop-in for all Claude calls |
| `scripts/dataforseo-onpage.ts` | DataForSEO OnPage API client (replaces Screaming Frog) |
| `scripts/onpage-to-csv.ts` | Transforms OnPage API data to SF-compatible CSVs |
| `scripts/run-pipeline.sh` | Sequential pipeline orchestrator with QA gates |
| `src/pipeline-server.ts` | HTTP trigger server for pipeline runs |
| `Dockerfile.railway` | Railway deployment (pipeline server only) |
| `groups/global/CLAUDE.md` | Global persona injected into all agents (read-only) |
| `groups/main/CLAUDE.md` | Main group persona with admin/group management context |
| `groups/{name}/CLAUDE.md` | Per-group memory (isolated) |

## Runtime Directories (not in repo)

```
store/messages.db              # SQLite database
store/auth/                    # WhatsApp baileys credentials
data/ipc/{group}/              # IPC namespace per group
data/sessions/{group}/.claude/ # Claude SDK sessions per group
groups/{group}/logs/           # Per-run container logs
groups/{group}/conversations/  # Archived transcripts (PreCompact hook)
```

## Testing Patterns

- **vitest** with `vi.mock()` for module mocking and `vi.useFakeTimers()` for timeout control
- `db.ts` exports `_initTestDatabase()` for in-memory SQLite — used in `beforeEach` for clean state
- Container-runner tests mock `child_process.spawn` with fake `EventEmitter` + `PassThrough` streams
- Config overrides via `vi.mock('./config.js', () => ({...}))`
- CI runs `tsc --noEmit` then `vitest run` on ubuntu/Node 20

## Code Conventions

- ESM project (`"type": "module"`). Imports use `.js` extensions (e.g., `import { foo } from './config.js'`).
- Prettier with `singleQuote: true`.
- `Channel` interface (`src/types.ts`) is the extension point for new messaging channels — implement `name`, `connect()`, `sendMessage()`, `isConnected()`, `ownsJid()`, `disconnect()`, optionally `setTyping()`.
- Bot messages are identified by `is_bot_message` flag plus `content LIKE 'Andy:%'` as backstop for pre-migration rows.

## Container Build Cache

Apple Container's buildkit caches aggressively. `--no-cache` alone does NOT invalidate COPY steps. To force a truly clean rebuild:

```bash
container builder stop && container builder rm && container builder start
./container/build.sh
```

Verify after rebuild: `container run -i --rm --entrypoint wc nanoclaw-agent:latest -l /app/src/index.ts`

Note: agent-runner source changes do NOT require a rebuild (recompiled at container start). Only Dockerfile changes (system packages, npm dependencies) need a full rebuild.

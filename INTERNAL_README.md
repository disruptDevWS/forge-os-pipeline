# NanoClaw — Internal Reference

Personal Claude assistant. A single Node.js process connects to WhatsApp, routes messages to the Claude Agent SDK running inside Docker containers. Each WhatsApp group gets an isolated container with its own filesystem and memory. Also houses the ForgeOS SEO audit pipeline — a standalone multi-phase system that crawls sites, researches keywords, and designs information architecture.

```
WhatsApp (Baileys) --> SQLite --> Poll Loop (2s) --> GroupQueue --> Docker Container (Claude Agent SDK) --> Response
                                                                         |
                                                                    File-based IPC
```

---

## Table of Contents

- [Architecture](#architecture)
- [Message Flow](#message-flow)
- [Project Structure](#project-structure)
- [Source Files — Host Process](#source-files--host-process)
- [Container System](#container-system)
- [IPC Model](#ipc-model)
- [Security Model](#security-model)
- [Task Scheduler](#task-scheduler)
- [Agent Personas](#agent-personas)
- [SEO Audit Pipeline (ForgeOS)](#seo-audit-pipeline-forgeos)
- [Testing](#testing)
- [Development](#development)
- [Configuration](#configuration)

---

## Architecture

### Components

| Component | File | Role |
|-----------|------|------|
| **WhatsApp Channel** | `src/channels/whatsapp.ts` | Connects via Baileys, receives and sends messages |
| **SQLite Database** | `src/db.ts` | Stores messages, groups, sessions, tasks, router state |
| **Poll Loop** | `src/index.ts` | Every 2s, checks for new messages across registered groups |
| **GroupQueue** | `src/group-queue.ts` | Enforces one container per group, max 5 concurrent |
| **Container Runner** | `src/container-runner.ts` | Spawns Docker containers, passes secrets via stdin, streams output |
| **Agent Runner** | `container/agent-runner/src/index.ts` | Runs inside the container — executes Claude Agent SDK queries |
| **IPC Watcher** | `src/ipc.ts` | Polls `data/ipc/` for outbound messages and task operations |
| **Task Scheduler** | `src/task-scheduler.ts` | Polls for due cron/interval/once tasks every 60s |
| **MCP Server** | `container/agent-runner/src/ipc-mcp-stdio.ts` | Stdio MCP server inside containers, exposes IPC tools to the agent |
| **Router** | `src/router.ts` | Message formatting (XML) and outbound routing |
| **Config** | `src/config.ts` | All constants, reads `.env` without polluting `process.env` |
| **Mount Security** | `src/mount-security.ts` | Validates container mounts against external allowlist |

### How They Connect

The **orchestrator** (`src/index.ts`) wires everything together. It initializes the database, creates the WhatsApp channel, starts the poll loop, scheduler, and IPC watcher, and registers callbacks with the GroupQueue.

When a message arrives, WhatsApp stores it in SQLite via `db.storeMessage()`. The poll loop (`startMessageLoop`) picks it up via `db.getNewMessages()`, checks trigger patterns, and enqueues work in the GroupQueue. The queue calls `processGroupMessages()`, which fetches conversation history via `db.getMessagesSince()`, formats it as XML via `router.formatMessages()`, and spawns a container via `container-runner.runContainerAgent()`.

Inside the container, the Agent Runner receives the prompt via stdin, runs a Claude SDK `query()` call, and writes responses to stdout wrapped in sentinel markers. The MCP server gives the agent tools to send messages and schedule tasks — all via file writes that the host IPC watcher picks up and routes.

**Dependency graph:**

```
index.ts
  ├── channels/whatsapp.ts  (Channel interface from types.ts)
  ├── db.ts                 (imports config.ts, types.ts)
  ├── group-queue.ts        (imports config.ts, logger.ts)
  ├── container-runner.ts   (imports config.ts, env.ts, mount-security.ts, types.ts)
  ├── task-scheduler.ts     (imports config.ts, container-runner.ts, db.ts, group-queue.ts)
  ├── ipc.ts                (imports config.ts, container-runner.ts, db.ts, types.ts)
  ├── router.ts             (imports types.ts)
  └── logger.ts             (standalone)

config.ts
  └── env.ts                (reads .env without process.env)

mount-security.ts
  └── config.ts, types.ts

container/agent-runner/src/
  ├── index.ts              (Claude Agent SDK, IPC polling, MessageStream)
  └── ipc-mcp-stdio.ts      (MCP server, file-based IPC writes)
```

---

## Message Flow

1. **Inbound**: WhatsApp message arrives via Baileys WebSocket. `WhatsAppChannel.messages.upsert` handler stores it in SQLite (`messages` table) via `db.storeMessage()` and records chat metadata via `db.storeChatMetadata()`.

2. **Poll**: Every 2s, `startMessageLoop()` in `index.ts` calls `db.getNewMessages()` for all registered group JIDs. Messages are grouped by `chat_jid`.

3. **Trigger check**: For non-main groups, the message must match `TRIGGER_PATTERN` (e.g., `@Dwight`). The main group processes every message. If a container is already running for the group, the message is piped to it via `queue.sendMessage()` (writes a JSON file to the IPC input directory) instead of spawning a new container.

4. **Queue**: `GroupQueue.enqueueMessageCheck()` enforces one container per group and max 5 concurrent containers globally. Tasks take priority over messages in the drain order. Failed runs retry with exponential backoff (5s base, 5 max retries).

5. **Context assembly**: `processGroupMessages()` in `index.ts` fetches all messages since the last agent interaction via `db.getMessagesSince()`. Messages are formatted as XML via `router.formatMessages()`:
   ```xml
   <messages>
     <message sender="Matt" time="10:30 AM">Can you check the site?</message>
   </messages>
   ```

6. **Container spawn**: `container-runner.runContainerAgent()` builds volume mounts via `buildVolumeMounts()`, spawns `docker run -i --rm`, and writes secrets (API keys) as JSON to stdin. The container compiles TypeScript on startup from the host-mounted source.

7. **Agent execution**: Inside the container, `agent-runner/index.ts` reads stdin, calls `claude.query()` with a `MessageStream` (async iterable). The agent polls `/workspace/ipc/input/` for follow-up messages during execution.

8. **Output streaming**: Each response is wrapped in sentinel markers (`---NANOCLAW_OUTPUT_START---` / `---NANOCLAW_OUTPUT_END---`). The host parses these in real-time and delivers each chunk to WhatsApp immediately.

9. **Outbound**: `router.stripInternalTags()` removes `<internal>...</internal>` blocks. The cleaned text is sent via `whatsapp.sendMessage()`. If `ASSISTANT_HAS_OWN_NUMBER` is false, responses are prefixed with `"Dwight: "`.

10. **Session persistence**: The container returns a `newSessionId` stored in SQLite via `db.setSession()`. The next interaction resumes from `resumeAt` (the UUID of the last assistant message), preventing the stale-branch-tip bug where follow-up queries fork from an old conversation point.

---

## Project Structure

```
nanoclaw/
  src/                          # Host process (12 modules + 7 test files)
    index.ts                    # Orchestrator: state, message loop, agent invocation
    channels/whatsapp.ts        # WhatsApp connection via Baileys
    config.ts                   # All configuration constants
    db.ts                       # SQLite operations (7 tables)
    env.ts                      # .env parser (never touches process.env)
    router.ts                   # Message formatting and outbound routing
    container-runner.ts         # Docker spawn + streaming output parser
    group-queue.ts              # Per-group queue with global concurrency limit
    ipc.ts                      # IPC watcher and task authorization
    task-scheduler.ts           # Cron/interval/once scheduled tasks
    mount-security.ts           # Allowlist-based mount path validation
    logger.ts                   # Pino logger setup
    types.ts                    # All TypeScript interfaces
    whatsapp-auth.ts            # Standalone WhatsApp auth script

  container/
    Dockerfile                  # node:22-slim + Chromium + claude-code
    build.sh                    # Docker image build script
    agent-runner/
      src/
        index.ts                # In-container SDK query loop + MessageStream
        ipc-mcp-stdio.ts        # MCP server exposing IPC tools to the agent
    skills/
      agent-browser/            # Browser automation skill

  scripts/                      # SEO pipeline (standalone, no Docker/WhatsApp)
    run-pipeline.sh             # Full pipeline orchestrator
    pipeline-generate.ts        # Agent phases: Dwight, Jim, Michael, etc.
    sync-to-dashboard.ts        # Supabase sync: keywords, pages, blueprints
    foundational_scout.sh       # DataForSEO API wrapper
    generate-brief.ts           # Pam brief generation (polls pam_requests)
    generate-content.ts         # Oscar content production (polls oscar_requests)

  groups/                       # Agent personas and per-group memory
    global/CLAUDE.md            # Global persona (all agents, read-only)
    main/CLAUDE.md              # Main group persona (admin context)
    {name}/CLAUDE.md            # Per-group memory (isolated)

  .claude/agents/               # Pipeline agent definitions
    Dwight.md                   # Technical SEO auditor
    Jim.md                      # DataForSEO research scout
    Michael.md                  # Information architect
    Pam.md                      # Content synthesizer

  configs/oscar/                # Oscar content production config
    system-prompt.md            # Oscar system prompt (writing style, structure rules)
    seo-playbook.md             # SEO content playbook (semantic HTML patterns)

  docs/                         # Documentation
    REQUIREMENTS.md             # Design philosophy
    SECURITY.md                 # Trust model and security boundaries
    SPEC.md                     # Full specification
    PIPELINE.md                 # SEO pipeline phase reference
    SDK_DEEP_DIVE.md            # Claude Agent SDK internals
    DEBUG_CHECKLIST.md          # Troubleshooting

  store/                        # Runtime (gitignored)
    messages.db                 # SQLite database
    auth/                       # WhatsApp Baileys credentials

  data/                         # Runtime (gitignored)
    ipc/{group}/                # IPC namespace per group
    sessions/{group}/.claude/   # Claude SDK sessions per group
```

---

## Source Files — Host Process

### `src/types.ts` — Type Definitions

All shared TypeScript interfaces. No runtime dependencies — this is the foundation everything else imports.

- **`Channel`** — extension point for new messaging channels. Implement `name`, `connect()`, `sendMessage()`, `isConnected()`, `ownsJid()`, `disconnect()`, and optionally `setTyping()`.
- **`RegisteredGroup`** — a WhatsApp group registered for agent interaction: trigger pattern, folder mapping, optional `ContainerConfig` (additional mounts, timeout).
- **`NewMessage`** — inbound message with sender, content, timestamp, and bot detection flags (`is_from_me`, `is_bot_message`).
- **`ScheduledTask`** — task record with cron/interval/once schedule, status tracking, retry count, and `context_mode` (`'group'` uses existing session, `'isolated'` starts fresh).
- **`MountAllowlist` / `AllowedRoot`** — security config for the external mount allowlist, with per-root `readOnly` and `nonMainReadOnly` flags.

### `src/config.ts` — Configuration

All constants in one place. Reads from `.env` via `readEnvFile()` from `env.ts` — never from `process.env`.

| Constant | Default | Purpose |
|----------|---------|---------|
| `ASSISTANT_NAME` | `'Andy'` | Trigger word and message prefix |
| `POLL_INTERVAL` | 2000ms | Message poll frequency |
| `SCHEDULER_POLL_INTERVAL` | 60000ms | Task scheduler poll frequency |
| `CONTAINER_TIMEOUT` | 30min | Hard timeout per container |
| `IDLE_TIMEOUT` | 30min | Inactivity timeout (writes `_close` sentinel) |
| `MAX_CONCURRENT_CONTAINERS` | 5 | Global container concurrency limit |
| `CONTAINER_MAX_OUTPUT_SIZE` | 10MB | Output buffer limit per container |
| `IPC_POLL_INTERVAL` | 1000ms | IPC directory poll frequency |
| `TRIGGER_PATTERN` | `/^@Andy\b/i` | Message trigger regex |

**Why secrets aren't here:** `config.ts` is imported by nearly every module. If secrets lived here, they'd propagate to `process.env` via `child_process.spawn()` defaults. By confining secret reads to `container-runner.ts` (the only consumer), the leakage vector is eliminated at the source.

### `src/env.ts` — Environment File Parser

Single export: `readEnvFile(keys: string[]): Record<string, string>`.

Parses `.env` from `process.cwd()`, returns only the requested keys. Handles quoted values. Never modifies `process.env`. This design decision ensures secrets cannot leak to child processes through environment inheritance.

### `src/db.ts` — SQLite Database

Module-level singleton via `better-sqlite3` (synchronous API — no async overhead for single-connection SQLite).

**Schema (7 tables):**

| Table | Purpose | Key Design Notes |
|-------|---------|-----------------|
| `chats` | All seen WhatsApp chats | Enables group discovery without WhatsApp API calls |
| `messages` | Message store | Composite PK `(id, chat_jid)`, indexed by timestamp |
| `scheduled_tasks` | Task records | Supports cron/interval/once, `context_mode` field |
| `task_run_logs` | Execution history | Duration, status, result, error per run |
| `router_state` | Key-value store | `last_timestamp` + per-group `last_agent_timestamp` |
| `sessions` | Claude SDK sessions | Session ID per group folder for conversation continuity |
| `registered_groups` | Group registry | JID, name, folder, trigger, container config as JSON |

**Bot message detection** uses two signals: the `is_bot_message` flag (set on insert) plus `content LIKE 'Andy:%'` as a backstop for pre-migration rows that lack the flag. This dual approach was a deliberate migration strategy — the LIKE check catches old rows while new rows use the flag.

**Migrations** are `ALTER TABLE ... ADD COLUMN` wrapped in try/catch (ignore if column already exists). This is intentionally simple — no migration framework, no version tracking, just idempotent schema changes.

`_initTestDatabase()` creates an in-memory SQLite instance for tests, enabling clean state in `beforeEach` without filesystem operations.

### `src/router.ts` — Message Formatting and Routing

Pure functions with no side effects. Imported by `index.ts` for message formatting and by tests for verification.

- `escapeXml()` — escapes `&`, `<`, `>`, `"` for safe XML embedding
- `formatMessages()` — wraps message arrays in `<messages><message sender="..." time="...">` XML. This XML format was chosen over JSON because Claude handles XML context natively and it's more compact than JSON for conversation threading.
- `stripInternalTags()` — regex removal of `<internal>...</internal>` blocks. Agents use these for reasoning that shouldn't be shown to users.
- `formatOutbound()` — strips internal tags and returns cleaned text
- `routeOutbound()` — finds the owning channel for a JID via `ownsJid()` and calls its `sendMessage()`
- `findChannel()` — channel lookup by JID ownership

### `src/container-runner.ts` — Container Lifecycle

The bridge between the host process and Docker containers. This is the most complex module in the host process.

**`buildVolumeMounts(group, isMain)`**: Constructs Docker `-v` arguments. Main group gets the project root at `/workspace/project` (read-write). Non-main groups get only their folder at `/workspace/group` plus `groups/global/` at `/workspace/global` (read-only). Additional mounts are validated via `mount-security.ts`. Also initializes the Claude SDK `settings.json` (enabling agent teams, setting CLAUDE.md paths) and syncs skills from `container/skills/`.

**`readSecrets()`**: Reads `CLAUDE_CODE_OAUTH_TOKEN` and `ANTHROPIC_API_KEY` from `.env` via `env.ts`. These are the only two secrets the system handles.

**`runContainerAgent(group, input, onProcess, onOutput?)`**: The main entry point. Spawns `docker run -i --rm`, writes secrets to stdin as JSON, then enters a streaming output parser. The parser looks for sentinel marker pairs (`---NANOCLAW_OUTPUT_START---` / `---NANOCLAW_OUTPUT_END---`) and delivers each parsed JSON result to the `onOutput` callback immediately. A sequential promise chain preserves output ordering even when multiple chunks arrive rapidly. The hard timeout resets on every output — this is critical because it distinguishes idle containers (which should be shut down) from active containers that are taking time between responses.

**Graceful shutdown**: Uses `docker stop` (sends SIGTERM + 10s grace), falls back to `container.kill('SIGKILL')` if the process doesn't exit.

**Logging**: Each run writes to `groups/{folder}/logs/container-{timestamp}.log`. Verbose mode logs full stdin/stdout/stderr; normal mode logs a summary with timing.

### `src/group-queue.ts` — Concurrency Control

Manages per-group state with a global concurrency limit.

**Per-group state machine:**
- `active: boolean` — whether a container is running for this group
- `pendingMessages: boolean` — new messages arrived while container was running
- `pendingTasks: QueuedTask[]` — tasks queued while container was running
- `process` — reference to the running Docker child process
- `retryCount` — exponential backoff counter

**Rules:**
- One container per group at a time. New messages for an active group are delivered via IPC (`sendMessage()` writes a JSON file to the input directory).
- Max 5 containers globally. Groups beyond the limit enter a global waiting list.
- Tasks are prioritized over messages: when a container finishes, `drainGroup()` checks `pendingTasks` before `pendingMessages`.
- Failed runs retry with exponential backoff: `5s * 2^retryCount`, up to 5 retries. `scheduleRetry()` uses `setTimeout`.

**`sendMessage(groupJid, text)`**: Writes a JSON file to `data/ipc/{folder}/input/` using atomic temp+rename. Returns false if no active container exists for the group. This is how follow-up messages reach a running agent.

**`closeStdin(groupJid)`**: Writes the `_close` sentinel file to the input directory. The agent-runner polls for this and exits gracefully.

### `src/ipc.ts` — Inter-Process Communication

Polls `data/ipc/` every 1s. Processes two directories per group:

- `messages/*.json` — outbound messages from the agent. Each file contains `{type, chatJid, text}`. The watcher calls `sendMessage` on the appropriate channel.
- `tasks/*.json` — task operations: `schedule_task`, `pause_task`, `resume_task`, `cancel_task`, `refresh_groups`, `register_group`.

**Authorization model**: The key security insight is that identity comes from the filesystem path, not from the JSON payload. A container writing to `data/ipc/marketing/messages/` is inherently the `marketing` group — it cannot write to another group's IPC directory because Docker mounts only expose its own directory. Non-main groups can only message and schedule tasks for themselves. The main group has cross-group access.

**Error handling**: Failed IPC files are moved to `data/ipc/errors/` with a timestamp prefix. This preserves evidence for debugging without blocking the watcher.

### `src/task-scheduler.ts` — Scheduled Tasks

Polls `db.getDueTasks()` every 60s. Before running each task, re-checks its status (guards against pause/cancel between poll and execution).

**`runTask(task, deps)`**: Finds the registered group, writes a tasks snapshot, calls `runContainerAgent()`. `context_mode: 'group'` passes the existing session ID (agent has conversation history). `'isolated'` passes no session (fresh context). An idle timer writes `_close` after `IDLE_TIMEOUT` of no output.

After execution: logs to `task_run_logs`, computes next run time for cron/interval tasks via `cron-parser`.

### `src/mount-security.ts` — Mount Validation

Validates additional container mounts against `~/.config/nanoclaw/mount-allowlist.json`. This file lives outside the project and is never mounted into containers — making it tamper-proof.

**Validation checks:**
1. Allowlist file exists and is valid JSON
2. Container path has no `..` traversal and isn't absolute
3. Host path exists (resolves symlinks to catch junction attacks)
4. Path doesn't match blocked patterns (`.ssh`, `.gnupg`, `.aws`, `.env`, `id_rsa`, etc.)
5. Path falls under an allowed root
6. Effective readonly computed from root config and `nonMainReadOnly` flag

### `src/channels/whatsapp.ts` — WhatsApp Channel

Implements the `Channel` interface using `@whiskeysockets/baileys`.

**Connection lifecycle**: Loads auth state from `store/auth/`, creates a Baileys socket with `Browsers.ubuntu('Chrome')`. QR code display triggers exit (auth is handled separately via `npm run auth` / `whatsapp-auth.ts`). Reconnects automatically on close unless explicitly logged out.

**LID translation**: WhatsApp assigns "Linked ID" JIDs to some contacts. The channel maintains a LID-to-phone map built from the signal identity store and refreshed on connection. `translateJid()` converts LID JIDs to phone JIDs for consistent identification.

**Outgoing queue**: Messages sent while disconnected are queued in an array and flushed on reconnect via `flushOutgoingQueue()`. This prevents message loss during brief WebSocket drops.

**Group metadata sync**: `syncGroupMetadata()` fetches all participating groups from WhatsApp and updates chat names in SQLite. Respects a 24-hour cache (stored as a special `__group_sync__` chat row) to avoid rate limiting.

**Bot message detection**: When `ASSISTANT_HAS_OWN_NUMBER` is true, bot messages are detected by `fromMe`. Otherwise, by the content prefix pattern (`Dwight:`).

### `src/logger.ts` — Structured Logging

Creates a `pino` logger with `pino-pretty` transport. Registers global `uncaughtException` and `unhandledRejection` handlers that log through pino before calling `process.exit(1)`.

### `src/pipeline-server.ts` — Pipeline Trigger HTTP Server

Minimal HTTP server (Node built-in `http` module, no dependencies) that receives pipeline trigger requests from the Supabase `run-audit` Edge Function.

- `POST /trigger-pipeline` — only endpoint, everything else → 404
- **Auth**: `Authorization: Bearer <PIPELINE_TRIGGER_SECRET>` — 401 if missing/wrong
- **Payload**: `{ "domain": "example.com", "email": "user@example.com" }`
- **Duplicate guard**: `Set<string>` tracks in-flight domains, returns 409 if already running
- Responds **202 Accepted** immediately, then spawns `./scripts/run-pipeline.sh` detached
- Binds `0.0.0.0:3847` (configurable via `PIPELINE_SERVER_PORT`)
- Exports `startPipelineServer()` and `stopPipelineServer()`
- Disables itself if `PIPELINE_TRIGGER_SECRET` is empty

### `src/whatsapp-auth.ts` — Standalone Authentication

Run via `npm run auth`. Creates a temporary WhatsApp socket, displays a QR code (or pairing code with `--pairing-code --phone NNNN`), saves credentials to `store/auth/`, and exits. Writes status files for external monitoring (`store/auth-status.txt`, `store/qr-data.txt`).

### `src/index.ts` — Orchestrator

The main entry point that ties everything together.

**Module-level state:**
- `lastTimestamp` — newest message timestamp seen across all groups
- `sessions: Map<string, string>` — session IDs per group folder
- `registeredGroups: Map<string, RegisteredGroup>` — registered groups by JID
- `lastAgentTimestamp: Map<string, number>` — per-group cursor for conversation context
- `queue: GroupQueue` — the global queue instance

**Key functions:**

`processGroupMessages(chatJid)`: The core processing function, called by GroupQueue. Fetches messages since last agent interaction, checks trigger pattern for non-main groups, formats as XML, and runs the container. Sets up idle timer. Streams output to WhatsApp in real-time. Advances cursor optimistically before container runs; rolls back if container fails with no output.

`startMessageLoop()`: Infinite 2s poll. Calls `getNewMessages()`, groups by chat JID, checks triggers. If a container is already running for the group, pipes the message via `queue.sendMessage()`. Otherwise enqueues a new container check.

`recoverPendingMessages()`: Startup recovery — scans all registered groups for unprocessed messages (gap between `lastTimestamp` and `lastAgentTimestamp`), enqueues if found.

`main()`: Startup sequence:
1. `ensureDockerRunning()` — checks `docker info`, kills orphaned containers
2. `initDatabase()` — creates SQLite schema
3. `loadState()` — reads timestamps, sessions, registered groups from SQLite
4. Register SIGTERM/SIGINT handlers for graceful shutdown
5. `startPipelineServer()` — HTTP trigger server (independent of WhatsApp)
6. **`--pipeline-only` check** — if flag present, returns here (no WhatsApp, no Docker queue)
7. Create `WhatsAppChannel` with message and metadata callbacks
8. `whatsapp.connect()` — waits for first connection
9. `startSchedulerLoop()` — begins task polling
10. `startIpcWatcher()` — begins IPC directory polling
11. Set `queue.setProcessMessagesFn(processGroupMessages)`
12. `recoverPendingMessages()` — catch up from any crash
13. `startMessageLoop()` — begin message polling

---

## Container System

### Dockerfile

Base image: `node:22-slim`. Installs Chromium (for the `agent-browser` skill), curl, git, and globally installs `@anthropic-ai/claude-code`.

**Entrypoint recompilation**: The entrypoint script recompiles TypeScript on every container start from the host-mounted source at `/app/src`:

```bash
cd /app && npx tsc --outDir /tmp/dist
ln -s /app/node_modules /tmp/dist/node_modules
chmod -R a-w /tmp/dist
cat > /tmp/input.json
node /tmp/dist/index.js < /tmp/input.json
```

This means agent-runner code changes take effect immediately without rebuilding the Docker image. Only Dockerfile changes (system packages, npm dependencies) require `./container/build.sh`.

The compiled output goes to `/tmp/dist` (read-only after compilation). Stdin is captured to `/tmp/input.json` and read by `index.ts` on startup.

### Volume Mounts

| Container Path | Host Source | Access | Notes |
|----------------|------------|--------|-------|
| `/workspace/group` | `groups/{folder}/` | RW | Per-group memory, CLAUDE.md, logs |
| `/workspace/global` | `groups/global/` | RO | Global persona (non-main only) |
| `/workspace/project` | project root | RW | Full project access (main only) |
| `/home/node/.claude` | `data/sessions/{folder}/.claude/` | RW | Claude SDK session state |
| `/workspace/ipc` | `data/ipc/{folder}/` | RW | IPC communication directory |
| `/app/src` | `container/agent-runner/src/` | RO | Source recompiled on start |
| `/workspace/extra/{name}` | additional mounts | configurable | Validated via allowlist |

The main group mount at `/workspace/project` is the key trust distinction — it gives the main channel's agent read-write access to the entire NanoClaw codebase, enabling self-modification and admin operations.

### Agent Runner (`container/agent-runner/src/index.ts`)

The main process inside each container.

**MessageStream**: A custom push-based async iterable. `push(text)` enqueues a user message; `end()` signals completion. The async iterator blocks waiting for new items. This is passed as the `prompt` to `claude.query()`.

**Why MessageStream instead of a string?** Passing a string prompt sets `isSingleUserTurn = true` in the SDK, which closes stdin after the first result — killing agent teams support. By passing an `AsyncIterable<SDKUserMessage>`, `isSingleUserTurn` stays `false` and the CLI remains alive for multi-turn interactions. This was the critical insight from reverse-engineering the SDK (documented in `docs/SDK_DEEP_DIVE.md`).

**Query loop**:
1. Read stdin JSON, parse `ContainerInput`
2. Delete `/tmp/input.json` (security: no secrets on disk)
3. Build `sdkEnv` by merging secrets into a copy of `process.env` (never actual `process.env`)
4. Clean up stale `_close` sentinel
5. Drain any pending IPC messages into initial prompt
6. Call `runQuery()` — runs `claude.query()`, polls IPC during execution
7. If `_close` detected during query, exit
8. Emit session-update marker (for host to track session ID)
9. Call `waitForIpcMessage()` — blocks until new input or `_close`
10. If new message: loop back to step 6 with `resumeAt` (last assistant UUID)
11. If `_close`: exit cleanly

**Hooks:**
- `PreCompact` — archives conversation transcripts to `conversations/{date}-{summary}.md` before SDK context compaction. Reads the JSONL transcript file, parses user/assistant messages, generates a markdown summary.
- `PreToolUse Bash` — prepends `unset ANTHROPIC_API_KEY CLAUDE_CODE_OAUTH_TOKEN 2>/dev/null;` to every bash command. This prevents secrets from leaking to any subprocess the agent spawns.

### MCP Server (`container/agent-runner/src/ipc-mcp-stdio.ts`)

A `@modelcontextprotocol/sdk` stdio server using `zod` for input validation. Runs as a subprocess of the Claude Agent SDK (configured in `settings.json`).

| Tool | Description | Authorization |
|------|-------------|--------------|
| `send_message` | Send message to a WhatsApp chat | Main: any chat. Others: own chat only |
| `schedule_task` | Create cron/interval/once task | Main: any group. Others: own group |
| `list_tasks` | Read `current_tasks.json` | Pre-written by host, scoped per group |
| `pause_task` | Pause a running task | Writes to tasks IPC dir |
| `resume_task` | Resume a paused task | Writes to tasks IPC dir |
| `cancel_task` | Cancel a task | Writes to tasks IPC dir |
| `register_group` | Register new WhatsApp group | Main only |

All file writes are atomic (write to temp file, then `fs.renameSync`) to prevent partial reads by the host IPC watcher. Context (chat JID, group folder, isMain) comes from environment variables set by `container-runner.ts`.

---

## IPC Model

File-based IPC via `data/ipc/{groupFolder}/`:

```
data/ipc/{group}/
  messages/              Container -> Host: outbound messages
  tasks/                 Container -> Host: task operations
  input/                 Host -> Container: follow-up messages
  input/_close           Host -> Container: graceful shutdown sentinel
  current_tasks.json     Pre-written snapshot (host -> container, read-only)
  available_groups.json  Pre-written snapshot (host -> container, main only)
```

**Why files instead of sockets?** Docker volume mounts make file-based IPC trivial — no port mapping, no network configuration. Atomic temp+rename prevents partial reads. Failed files survive in `data/ipc/errors/` for debugging. The container doesn't need network access to the host.

**Why a `_close` sentinel instead of SIGTERM?** The Claude Agent SDK manages its own subprocess tree (Claude CLI, MCP servers, agent teams). Sending SIGTERM to the container may not propagate cleanly through this tree. The `_close` file is checked cooperatively during the IPC poll loop, allowing the agent to finish its current operation and the SDK to clean up subprocesses before exiting.

**Authorization is structural, not data-driven**: A container at `data/ipc/marketing/` can only write to `marketing`'s directories because Docker only mounts that specific path. No payload inspection needed.

---

## Security Model

### Trust Levels

| Entity | Trust | Access |
|--------|-------|--------|
| Main group | Trusted | Full project access (RW), cross-group messaging, group management |
| Non-main groups | Untrusted | Own folder only, global persona (RO), own-group messaging |
| Containers | Sandboxed | Docker isolation, controlled mounts, non-root user, no host network |

### Five Security Boundaries

1. **Container isolation**: Each agent runs in Docker with `--rm` (auto-cleanup). Non-root `node` user inside the container. No `--network host` — containers have no direct host network access.

2. **Mount security**: Additional mounts validated against `~/.config/nanoclaw/mount-allowlist.json`. This file is outside the project and never mounted into containers (tamper-proof). Default blocked patterns: `.ssh`, `.gnupg`, `.aws`, `.env`, private keys.

3. **Session isolation**: Each group gets its own `.claude/` directory at `data/sessions/{folder}/.claude/`. No cross-group session leakage — even if an agent tries to read another group's session, the directory simply isn't mounted.

4. **IPC authorization**: Identity is the filesystem path, not data content. Enforced by Docker mount scoping (structural) and host IPC watcher validation (defense-in-depth).

5. **Credential handling**: API keys read from `.env` only in `container-runner.ts`, passed via stdin JSON (never env vars, never disk files). The `PreToolUse Bash` hook strips credential vars before every shell command. Known gap: credentials are technically visible to the agent's own Node.js process (necessary for SDK operation).

See [docs/SECURITY.md](docs/SECURITY.md) for the complete trust model.

---

## Task Scheduler

Agents can schedule recurring work via the `schedule_task` MCP tool:

| Type | Format | Example |
|------|--------|---------|
| `cron` | Standard cron expression | `0 9 * * 1` (Mondays at 9am) |
| `interval` | ISO 8601 duration | `PT1H` (every hour) |
| `once` | ISO 8601 datetime | `2025-06-01T09:00:00Z` |

**`context_mode`** controls session behavior:
- `'group'` — uses the group's existing session ID. The agent has full conversation history and memory.
- `'isolated'` — no session. Fresh context every run. Good for periodic reports that shouldn't inherit prior state.

The scheduler polls every 60s, enqueues due tasks via GroupQueue (tasks get priority over messages), logs results to `task_run_logs`, and computes next run times for recurring tasks.

---

## Agent Personas

### WhatsApp Bot Personas

**Global** (`groups/global/CLAUDE.md`): Loaded by all agents. Names the assistant, defines capabilities (web browsing, file ops, bash, scheduling, messaging), workspace conventions, `<internal>` tag usage, and formatting rules (WhatsApp-compatible, no markdown headings, single asterisks for bold).

**Main** (`groups/main/CLAUDE.md`): Inherits global. Adds admin context: group management, cross-group scheduling, full project access.

**Per-group** (`groups/{name}/CLAUDE.md`): Isolated memory per group. The agent only sees its own CLAUDE.md plus the global persona.

### Pipeline Agent Definitions (`.claude/agents/`)

These define behavior for the SEO audit pipeline (separate from the WhatsApp bot):

| Agent | File | Role |
|-------|------|------|
| **Dwight** | `Dwight.md` | Technical SEO auditor — Screaming Frog crawls, agentic readiness scoring, metadata analysis |
| **Jim** | `Jim.md` | DataForSEO research scout — keyword rankings, competitor overlap, SERP analysis |
| **Michael** | `Michael.md` | Information architect — silo design, URL structure, keyword assignment, semantic similarity analysis |
| **Pam** | `Pam.md` | Content synthesizer — metadata (Fact-Feel-Proof framework), JSON-LD schema, content outlines |
| **Oscar** | `configs/oscar/` | Content writer — produces production-ready semantic HTML from Pam's briefs |

---

## SEO Audit Pipeline (ForgeOS)

A standalone multi-phase system that runs independently of the WhatsApp bot. No Docker, no WhatsApp — just Node.js scripts calling the Claude CLI and external APIs, writing results to Supabase.

> **Authoritative contract:** `docs/PIPELINE.md` — who owns what data, what tables, before what phase runs. **Decision log:** `docs/DECISIONS.md` — why non-obvious choices were made. Both must be updated when phase responsibilities change.

### Trigger Flow

```
Dashboard (useCreateAudit)
  --> creates audits + audit_assumptions rows in Supabase
  --> calls run-audit Edge Function
      --> marks audit as running (agent_pipeline_status='queued')
      --> HTTP POST to NanoClaw pipeline server (src/pipeline-server.ts, port 3847)
          --> spawns run-pipeline.sh detached
```

The `run-audit` Edge Function is a **thin trigger** — it writes nothing to keyword/cluster/rollup tables. All DataForSEO, keyword seeding, clustering, and revenue modeling happens inside the pipeline.

The pipeline server (`src/pipeline-server.ts`) runs as a systemd user service (`nanoclaw-pipeline.service`) with `--pipeline-only` mode (no WhatsApp). Bearer token auth + duplicate-domain guard.

### Phase Flow

```
Dwight (1) --> KeywordResearch (2) --> Jim (3) --> sync jim (3b) --> Canonicalize (3c)
  --> rebuild clusters (3d) --> Competitors (4) --> Gap (5) --> Michael (6)
  --> Validator (6.5) --> sync michael (6b) --> sync dwight (6c)
  --> [on-demand] Pam briefs (7) --> Oscar content (8)
```

| Phase | What Happens | Model | Output |
|-------|-------------|-------|--------|
| **1. Dwight** | Screaming Frog crawl + technical audit | Sonnet (via Claude CLI) | `AUDIT_REPORT.md`, CSVs |
| **2. KeywordResearch** | Service x city x intent matrix, DataForSEO validation | Haiku (extraction) | Seeds `audit_keywords` in Supabase |
| **3. Jim** | DataForSEO ranked keywords + competitors + SERP | Sonnet | `ranked_keywords.json`, `research_summary.md` |
| **3b. sync jim** | Parse Jim's output, compute revenue estimates | N/A (parsing) | `audit_keywords`, preliminary clusters/rollups |
| **3c. Canonicalize** | Group keywords into semantic topics, classify intent | Haiku | Updates `canonical_key`, `intent_type`, `is_brand`, `is_near_me` |
| **3d. rebuild clusters** | Re-aggregate clusters using canonical groupings | N/A | `audit_clusters`, `audit_rollups` (authoritative) |
| **4. Competitors** | Top competitors per topic via DataForSEO | Haiku | `audit_topic_competitors` |
| **5. Gap** | Authority gaps + format gaps vs competitors | Sonnet | `content_gap_analysis.md` |
| **6. Michael** | Information architecture (silos, URLs, keywords) | Sonnet | `architecture_blueprint.md` |
| **6.5. Validator** | Cross-check gaps vs blueprint | Haiku | `coverage_validation.md`, `audit_coverage_validation` |
| **6b. sync michael** | Parse blueprint silo tables | N/A (parsing) | `agent_architecture_pages`, `execution_pages` |
| **6c. sync dwight** | Parse crawl CSVs + audit report | N/A (parsing) | `agent_technical_pages`, `audit_snapshots` |
| **7. Pam briefs** | Generate content brief per execution page | Sonnet (via `--print`) | `brief.md`, `schema.json`, updates `execution_pages.brief_md` |
| **8. Oscar content** | Produce semantic HTML from Pam's brief | Sonnet (via `--print`) | `page.html`, updates `execution_pages.content_html` |

**Why Phase 3d exists:** Phase 3b builds clusters before `canonical_key` exists (using naive `extractTopic()` word truncation), so "air conditioner repair boise idaho" and "air conditioner repair boise" are separate clusters. Phase 3c assigns canonical keys, and 3d rebuilds clusters using those keys so variants merge correctly. Clustering key priority: `canonical_key > cluster > topic > 'general'`.

### Prerequisites

| Table | Created By | Must Exist Before |
|-------|-----------|-------------------|
| `audits` | Dashboard `useCreateAudit` | Phase 1 |
| `audit_assumptions` | Dashboard (primary), `ensureAssumptions()` fallback | Phase 3b (revenue calc) |
| `benchmarks` | Seeded (one row per service vertical + 'other') | Assumption auto-creation |
| `ctr_models` | Seeded (one row with is_default=true) | Revenue calculation |

`ensureAssumptions()` in `sync-to-dashboard.ts` auto-creates assumptions from benchmark defaults if missing. This is a safety net — the primary path is Dashboard creation.

### Running

```bash
# Full pipeline (triggered automatically from dashboard, or manually)
./scripts/run-pipeline.sh <domain> <email> [seed_matrix.json] [competitor_urls] [--mode sales|full]

# Individual phases
npx tsx scripts/pipeline-generate.ts dwight --domain example.com --user-email user@example.com
npx tsx scripts/pipeline-generate.ts canonicalize --domain example.com --user-email user@example.com

# Sync specific agents
npx tsx scripts/sync-to-dashboard.ts --domain example.com --user-email user@example.com --agents jim,dwight,michael

# Rebuild clusters without re-syncing keywords (after canonicalize)
npx tsx scripts/sync-to-dashboard.ts --domain example.com --user-email user@example.com --rebuild-clusters
```

Sales mode skips Phases 4, 5, and 6.5 for faster turnaround.

Pam and Oscar are on-demand (triggered from the dashboard, not part of `run-pipeline.sh`):
```bash
npx tsx scripts/generate-brief.ts                                    # poll all pam_requests
npx tsx scripts/generate-brief.ts --domain example.com               # filter by domain
npx tsx scripts/generate-content.ts                                   # poll all oscar_requests
npx tsx scripts/generate-content.ts --domain example.com --slug page  # specific page
```

### Key Design Decisions

> See `docs/DECISIONS.md` for the full decision log with dates and rationale.

**`callClaude()` vs `callClaudeAsync()`**: `callClaude()` uses `spawnSync` for small prompts (fast, simple). `callClaudeAsync()` uses async `spawn` for large prompts (avoids ETIMEDOUT that `spawnSync` hits on prompts exceeding ~100KB). Both call the Claude CLI with `--print --model {model} --tools ''` (tools disabled to prevent the agent from using tools when we just want text output). All `CLAUDE*` env vars are stripped from the child process to prevent conversation transcript leakage.

**Prompt framing**: Every agent prompt wraps with "YOUR ENTIRE RESPONSE IS THE REPORT/BLUEPRINT/RAW JSON" at the top and bottom. Without this, models often prepend "Here is the report..." or append "Let me know if you need anything else" — both of which break downstream parsers.

**Intent classification**: Canonicalize uses explicit SEO intent taxonomy in the prompt. Without guidance, Haiku over-classifies `[service]+[city]` keywords as "transactional" when they're actually "commercial investigation." The prompt specifies: "Without an action verb, it is NOT transactional." Navigational intent is reserved for keywords containing recognizable brand names — generic service keywords are NEVER navigational.

**Revenue model**: Three-tier (low/mid/high) based on `ctr_models` and `audit_assumptions` in Supabase. Headline number uses mid-tier. Industry benchmarks in a shared `benchmarks` table with per-audit overrides in `audit_assumptions`. If `audit_assumptions` doesn't exist at sync time, `ensureAssumptions()` auto-creates from benchmark defaults.

**Keyword deduplication**: PostgREST's `.neq('source', 'value')` excludes NULL rows (a non-obvious behavior). The pipeline uses paired DELETE calls — one for `eq('source', 'ranked')`, one for `is('source', null)` — documented with `// PAIRED` comments in both files.

**Pipeline status**: The `agent_pipeline_status` field on `audits` tracks progress: `queued → audit → research → architecture → complete`. Updated by `update-pipeline-status.ts` called from `run-pipeline.sh`. The `run-audit` Edge Function sets `queued`; each phase boundary advances it forward.

**Near-miss / branded exclusion (three-layer defense)**: 1) sync-to-dashboard filters `intent !== 'navigational'` at insert time, 2) canonicalize post-step clears `is_near_miss` for newly-branded/navigational keywords, 3) cluster builder excludes `is_brand=true` and navigational/informational intent.

**Pam and Oscar — on-demand content generation**: Unlike Phases 1-6c (batch pipeline), Pam and Oscar are triggered per-page from the dashboard via `pam_requests` and `oscar_requests` tables. `generate-brief.ts` polls for pending `pam_requests`, gathers context (execution page data, client profile, market context, content gaps, brand voice from `client_profiles`), calls Claude `--print` to produce a brief (`brief.md` + `schema.json`), and upserts results into `execution_pages`. `generate-content.ts` does the same for `oscar_requests`, taking Pam's brief as input and producing production-ready semantic HTML. Oscar's system prompt and SEO playbook live in `configs/oscar/` (not `.claude/agents/`). The HTML output is stored in `execution_pages.content_html` and surfaced in the dashboard with a sandboxed iframe preview and download button.

### Resilience Mechanisms

- **Date fallback**: `resolveArtifactPath()` tries today's directory, falls back to most recent dated directory. Handles pipeline runs that span midnight.
- **Narration detection**: `validateArtifact()` rejects output containing meta-phrases like "Here is the...", "I've created...", "Below you'll find...". LLM narration breaks parsers.
- **Structural validation**: Michael's blueprint must contain `## Executive Summary` and `### Silo N:` headings. If missing, the phase retries automatically.
- **Revenue fallback**: When near-miss clustering (position 11-30) produces 0 non-brand clusters, falls back to all keywords with volume cap (<=2000) and conservative CTR (page-1-bottom, ~3%) instead of the aggressive position 2-3 target.
- **Assumptions fallback**: `ensureAssumptions()` auto-creates from benchmarks if missing, preventing silent $0 revenue across the board.

---

## Testing

```bash
npm test                           # Run all tests
npm run test:watch                 # Watch mode
npx vitest run src/db.test.ts      # Single file
```

| Test File | What It Covers |
|-----------|---------------|
| `db.test.ts` | Message store/retrieve, bot message filtering, task CRUD, chat metadata |
| `container-runner.test.ts` | Streaming output parsing (sentinel markers), timeouts, session ID tracking |
| `ipc-auth.test.ts` | IPC authorization: main vs non-main cross-group restrictions |
| `group-queue.test.ts` | Concurrency limits, task priority over messages, exponential retry backoff |
| `formatting.test.ts` | XML escaping, message formatting |
| `routing.test.ts` | Channel routing, JID ownership matching |
| `whatsapp.test.ts` | Message handling, bot detection logic, LID translation, outgoing queue |

**Patterns:**
- `_initTestDatabase()` for in-memory SQLite (clean state per test, no filesystem)
- `child_process.spawn` mocked with fake `EventEmitter` + `PassThrough` streams for container tests
- Config overrides via `vi.mock('./config.js', () => ({...}))` for isolation
- `vi.useFakeTimers()` for timeout-dependent tests

CI: `tsc --noEmit` then `vitest run` on Ubuntu / Node 20.

---

## Development

### Commands

```bash
npm run dev              # Run with hot reload (tsx)
npm run build            # Compile TypeScript (tsc)
npm run typecheck        # Type-check without emitting
npm run format           # Format with Prettier (singleQuote)
npm run format:check     # Check formatting
npm test                 # Run all tests (vitest)
npm run auth             # WhatsApp authentication (standalone)
npm run sync             # Sync agent output to Supabase
./container/build.sh     # Rebuild Docker image
```

### Code Conventions

- ESM project (`"type": "module"`). Imports use `.js` extensions: `import { foo } from './config.js'`
- Target: ES2022, module resolution: NodeNext
- Prettier with `singleQuote: true`
- Strict TypeScript, no ORMs, no frameworks
- Synchronous SQLite via `better-sqlite3` (no async overhead for single-connection)
- Pino for structured logging

### Adding a New Channel

Implement the `Channel` interface from `src/types.ts`:

```typescript
interface Channel {
  name: string;
  connect(): Promise<void>;
  sendMessage(jid: string, text: string): Promise<void>;
  isConnected(): boolean;
  ownsJid(jid: string): boolean;
  disconnect(): Promise<void>;
  setTyping?(jid: string, isTyping: boolean): Promise<void>;
}
```

Register it in `src/index.ts`. The router automatically finds the owning channel for each outbound message via `ownsJid()`.

### Container Image Rebuild

Agent-runner source changes do NOT require a rebuild (recompiled on container start from host-mounted source). Only Dockerfile changes (system packages, npm dependencies) need a rebuild:

```bash
./container/build.sh
```

---

## Configuration

### Environment Variables (`.env`)

| Variable | Required | Purpose |
|----------|----------|---------|
| `CLAUDE_CODE_OAUTH_TOKEN` | Yes* | Claude SDK OAuth token |
| `ANTHROPIC_API_KEY` | Yes* | Anthropic API key (fallback) |
| `ASSISTANT_NAME` | No | Bot name and trigger word (default: `Andy`) |
| `ASSISTANT_HAS_OWN_NUMBER` | No | `true` if bot has its own WhatsApp number |
| `CONTAINER_IMAGE` | No | Docker image (default: `nanoclaw-agent:latest`) |
| `CONTAINER_TIMEOUT` | No | Hard timeout in ms (default: 1800000) |
| `MAX_CONCURRENT_CONTAINERS` | No | Concurrency limit (default: 5) |
| `LOG_LEVEL` | No | Pino log level (default: `info`) |
| `SUPABASE_URL` | Pipeline | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Pipeline | Supabase service role key |
| `DATAFORSEO_LOGIN` | Pipeline | DataForSEO API login |
| `DATAFORSEO_PASSWORD` | Pipeline | DataForSEO API password |

*One of `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY` required for the WhatsApp bot.

### Mount Allowlist (`~/.config/nanoclaw/mount-allowlist.json`)

Controls which additional host paths can be mounted into non-default containers:

```json
{
  "allowedRoots": [
    {
      "path": "/home/user/projects",
      "readOnly": true,
      "nonMainReadOnly": true
    }
  ]
}
```

Lives outside the project. Never mounted into containers. Tamper-proof.

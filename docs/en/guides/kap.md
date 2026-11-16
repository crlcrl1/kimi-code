# Kimi Agent Protocol (KAP)

The local server started by `kimi web` (as well as the server embedded in the Kimi Code desktop app) exposes the **Kimi Agent Protocol (KAP)**: a local agent control protocol over HTTP REST (`/api/v1`) and WebSocket (`/api/v1/ws`). KAP is currently in Beta; behavioral rules and the full endpoint catalog live in [`kap.md`](https://code.kimi.com/kimi-code/kap.md), while every running server serves live machine-readable schemas at `GET /openapi.json` and `GET /asyncapi.json`.

## What KAP provides

KAP decouples Kimi Code's agent engine from any single UI — Kimi Code's own desktop app and web UI are clients built on top of KAP. External applications and orchestrators send control requests over HTTP and subscribe to live state over a single WebSocket connection within explicit role boundaries:

- **Multi-workspace and session management**: Create, resume, fork (`:fork`), archive, and export sessions on local directories or registered [remote environments](./remote-environment.md) (SSH / Docker), with multiple clients connected to the same server in real time.
- **Structured turn streaming and mid-turn control**: Stream structured `Turn` and `Item` events (reasoning, reply deltas, tool-call stages, and outputs); submit prompts, steer into a running turn (`/steer`), cancel (`:cancel`), undo turns (`:undo`), compact context (`:compact`), or open read-only side chats (`:btw`).
- **Interactive approvals and background task streams**: Route tool permission requests and structured questions (`interaction` frames) to your own UI or policy logic, and stream or control shell and subagent task output by UTF-8 byte offset.
- **Role-scoped tokens and passwordless local onboarding**: External clients authenticate with scoped credentials (read-only `viewer` or default `operator`) that isolate host-global provider/config settings and arbitrary host paths; supports subprocess `kimi web --port 0 --json`, local verification-code handshakes, and pure-CLI `kimi access` token management.

## Choosing an integration method

| You want to | Use | What you get |
| --- | --- | --- |
| Build a third-party client (web, desktop, chat bot, dashboard) or orchestrate Kimi Code with live state sync, mid-turn steering, or approval callbacks | **KAP** | A long-lived HTTP + WebSocket server ([`kimi web`](../reference/kimi-command.md#kimi-web)) with the same [sessions](./sessions.md), live turn streaming, mid-turn steering, approval callbacks, background task output, [skills](../customization/skills.md), [plugins](../customization/plugins.md), and [MCP](../customization/mcp.md) that power Kimi Code's own apps. |
| Connect Kimi Code to an editor or IDE with native ACP support (such as Zed or JetBrains AI Chat) | **[`kimi acp`](../reference/kimi-acp.md)** | A subprocess speaking the [Agent Client Protocol](https://agentclientprotocol.com/) over `stdio`, bound 1-to-1 to the host IDE with multi-turn sessions, approvals, and reverse-RPC file and terminal delegation (see [Using in IDEs](./ides.md)). |
| Work interactively in a terminal, or delegate **one-shot unattended tasks** in scripts, CI/CD, or parent workflows | **[`kimi` / `kimi -p`](../reference/kimi-command.md#non-interactive-execution)** | The terminal TUI for daily interactive work; for single-turn unattended delegation, run `kimi -p "<task>" --output-format stream-json` to stream structured JSONL to stdout and exit automatically without managing a server. |

## Build with an AI agent

The behavioral specification and endpoint catalog are published at [`https://code.kimi.com/kimi-code/kap.md`](https://code.kimi.com/kimi-code/kap.md) (which also instructs agents to inspect live `/openapi.json` and `/asyncapi.json` schemas during development). For one-off unattended tasks, prefer `kimi -p "<task>" --output-format stream-json`; when you need persistent sessions, live streaming, or mid-turn control, fill in the brackets below and send the prompt to your AI coding agent:

### Build a third-party client

```text
I am building [a coding agent client] and want its underlying agent service to integrate with Kimi Code over the KAP protocol. The complete specification is at https://code.kimi.com/kimi-code/kap.md — please implement the integration following that specification.
```

### Orchestrate Kimi Code in a multi-agent system

```text
I am building [a multi-agent collaboration system] and want to drive Kimi Code as [a peer agent / a controlled subagent] over the KAP protocol (with live state sync, mid-turn steering, and approval callbacks). The complete specification is at https://code.kimi.com/kimi-code/kap.md — please implement the integration following that specification.
```

## Connecting and authenticating

External clients and orchestrators **must never read `~/.kimi-code/server.token`** (an internal CLI host credential rejected by the Desktop embedded server). Instead, pick the bootstrap flow matching your deployment:

- **Spawn a subprocess (recommended for orchestrators and standalone clients)**: Run `kimi web --port 0 --json`. It implies `--no-open`, never touches `server.token`, mints an in-memory ephemeral `operator` token tied to the subprocess lifetime, and emits a single pure JSON line on `stdout`: `{"origin":"http://127.0.0.1:<port>","ws_url":"ws://127.0.0.1:<port>/api/v1/ws","token":"kap_...","role":"operator","kimi_agent_protocol_version":"0.1.0"}`.
- **Attach to a running Desktop app or `kimi web` instance**: Discover live instances via `~/.kimi-code/server/instances/*.json`, then call `POST /api/v1/access/requests` to obtain a `user_code` — Desktop and Web UI display a confirmation prompt, while CLI `kimi web` prints `Run: kimi access approve <user_code>`; once approved, exchange `device_code` once at `:exchange` to claim your `kap_...` token.
- **Provision tokens from the CLI**: Users can issue scoped tokens directly via `kimi access create --name <name> [--role operator|viewer]` (plaintext printed once), inspect them with `kimi access list`, and revoke them via `kimi access revoke <id>` (running servers hot-reload revocations and immediately close active WebSocket connections for that token).

## Quick start

This dependency-free Node.js 22+ script (`WebSocket` is built into Node.js 22+) spawns `kimi web --port 0 --json`, creates a session, subscribes over WebSocket, submits a prompt, and streams the reply. Save it as `demo.mjs` and run `node demo.mjs`:

```js
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const proc = spawn('kimi', ['web', '--port', '0', '--json'], {
  stdio: ['ignore', 'pipe', 'inherit'],
});
const { value: bootLine } = await createInterface({ input: proc.stdout })[Symbol.asyncIterator]().next();
const { origin, ws_url, token } = JSON.parse(bootLine);
const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

const { data: session } = await fetch(`${origin}/api/v1/sessions`, {
  method: 'POST',
  headers,
  body: JSON.stringify({ cwd: process.cwd() }),
}).then((r) => r.json());

const ws = new WebSocket(ws_url, [`kimi-code.bearer.${token}`]);
await new Promise((resolve) => ws.addEventListener('open', resolve, { once: true }));

let promptConsumed = false;
const done = new Promise((resolve) => {
  ws.addEventListener('message', async ({ data }) => {
    const frame = JSON.parse(data);
    if (frame.type === 'ping') {
      ws.send(JSON.stringify({ type: 'pong' }));
      return;
    }
    if (frame.type === 'response' && frame.request_id === 'sub-1') {
      await fetch(`${origin}/api/v1/sessions/${session.id}/prompts`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          prompt_id: 'p-1',
          content: [{ type: 'text', text: 'Summarize this directory in one sentence.' }],
        }),
      });
      return;
    }
    if (frame.type === 'item.ended' && frame.item.type === 'user_message' && frame.item.prompt_ids?.includes('p-1')) {
      promptConsumed = true;
    }
    if (frame.type === 'item.started' && frame.item.type === 'assistant_message' && frame.item.text) {
      process.stdout.write(frame.item.text);
    }
    if (frame.type === 'item.delta' && frame.field === 'text') {
      process.stdout.write(frame.delta);
    }
    if (frame.type === 'agent' && frame.agent_id === 'main' && frame.status === 'idle' && promptConsumed) {
      process.stdout.write('\n');
      resolve();
    }
  });
});

ws.send(JSON.stringify({ type: 'subscribe', request_id: 'sub-1', session_id: session.id, agent_ids: ['main'] }));
await done;
ws.close();
proc.kill('SIGTERM');
```

## Next steps

- [`kap.md` full protocol specification](https://code.kimi.com/kimi-code/kap.md) — role boundaries, `meta.capabilities` probing, defensive WebSocket reduction rules, and the complete endpoint catalog
- [`kimi` command](../reference/kimi-command.md#kimi-web) — CLI flags for `kimi web`, `kimi access`, and `-p` non-interactive mode
- [Using in IDEs](./ides.md) — connect Zed and JetBrains IDEs via `kimi acp`

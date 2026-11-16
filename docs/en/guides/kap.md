# Kimi Agent Protocol (KAP)

The local server started by `kimi web` (as well as the server embedded in the Kimi Code desktop app) exposes the **Kimi Agent Protocol (KAP)**: a local agent control protocol over HTTP REST (`/api/v1`) and WebSocket (`/api/v1/ws`). KAP is currently in Beta; the complete general specification is published at [`kap.md`](https://code.kimi.com/kimi-code/kap.md), and every running instance also serves live `GET /openapi.json` and `GET /asyncapi.json` schemas.

## What KAP provides

KAP decouples Kimi Code's agent engine from any single UI — Kimi Code's own desktop app and web UI are clients built on top of KAP. External applications and parent orchestrators send control requests over HTTP and subscribe to live state over a single WebSocket connection, gaining full access to the runtime:

- **Multi-workspace and session management**: Create, resume, fork (`:fork`), archive, and export sessions on local directories or registered [remote environments](./remote-environment.md) (SSH / Docker), with multiple clients connected to the same daemon in real time.
- **Structured turn streaming and mid-turn control**: Stream structured `Turn` and `Item` events (reasoning, reply deltas, tool-call stages, and outputs); submit prompts, steer into a running turn (`/steer`), cancel (`:cancel`), undo turns (`:undo`), compact context (`:compact`), or open read-only side chats (`:btw`).
- **Interactive approvals and background task streams**: Route tool permission requests and structured questions (`interaction` frames) to your own UI or policy logic, and stream or control shell and subagent task output by byte offset.
- **Runtime configuration and extensions**: Switch models, thinking levels, permission modes, and goals per session, and manage workspace files, [Agent Skills](../customization/skills.md), [plugins](../customization/plugins.md), and [MCP servers](../customization/mcp.md).

## Choosing an integration method

| You want to | Use | What you get |
| --- | --- | --- |
| Build a third-party client (web, desktop, chat bot, dashboard) or orchestrate Kimi Code as a peer or subagent in a multi-agent system | **KAP** | A long-lived HTTP + WebSocket daemon ([`kimi web`](../reference/kimi-command.md#kimi-web)) with the same [sessions](./sessions.md), live turn streaming, mid-turn steering, approval callbacks, background task output, [skills](../customization/skills.md), [plugins](../customization/plugins.md), and [MCP](../customization/mcp.md) that power Kimi Code's own apps. |
| Connect Kimi Code to an editor or IDE with native ACP support (such as Zed or JetBrains AI Chat) | **[`kimi acp`](../reference/kimi-acp.md)** | A subprocess speaking the [Agent Client Protocol](https://agentclientprotocol.com/) over `stdio`, bound 1-to-1 to the host IDE with multi-turn sessions, approvals, and reverse-RPC file and terminal delegation (see [Using in IDEs](./ides.md)). |
| Do interactive development in a terminal, or run unattended one-off tasks in scripts and CI/CD | **[`kimi` / `kimi -p`](../reference/kimi-command.md#non-interactive-execution)** | The terminal TUI for daily interactive work, or one-shot `-p` execution that writes plain text or `stream-json` (JSONL) to stdout and exits when finished. |

## Build with an AI agent

The complete KAP specification lives at [`https://code.kimi.com/kimi-code/kap.md`](https://code.kimi.com/kimi-code/kap.md). Fill in the brackets below and hand the prompt directly to your AI coding agent:

### Build a third-party client

For custom web/desktop/mobile UIs, chat bots (Lark, Slack, Discord), or multi-session team dashboards:

```text
I am building [a Slack bot / a team web dashboard / a custom client] and want its underlying agent backend to connect to Kimi Code via KAP. The protocol specification is at https://code.kimi.com/kimi-code/kap.md — please implement the integration following that guide.
```

### Orchestrate Kimi Code in a multi-agent system

For multi-agent systems, orchestrators, or automated workflows driving Kimi Code as a peer collaborator or a delegated subagent:

```text
I am building [a multi-agent system / an automated engineering workflow] and want to drive Kimi Code as [a peer agent / a subagent] over KAP to dispatch work and sync results. The protocol specification is at https://code.kimi.com/kimi-code/kap.md — please implement the runner and state synchronization following that guide.
```

## Quick start

To verify a local server by hand from your terminal, this 5-step walkthrough uses `curl` and a dependency-free Node.js script (Node.js 22+ includes a built-in `WebSocket` client):

### 1. Start the server

Run `kimi web --no-open --port 0` and set `KAP` and `TOKEN` from the `Local` origin (without `#token=...`) and `Token` printed in its startup output (without `--port 0`, the default address is `http://127.0.0.1:58627`):

```sh
export KAP="http://127.0.0.1:<port from startup output>"
export TOKEN="<Token from startup output>"
```

### 2. Create a session

JSON responses under `/api/v1` use the `{ code, msg, data, request_id }` envelope (`code: 0` indicates success):

```sh
curl -s -X POST "$KAP/api/v1/sessions" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"cwd\": \"$PWD\"}"
```

Store the returned `data.id` (`session_...`) in `SESSION`:

```sh
export SESSION="<data.id from the response>"
```

### 3. Subscribe to live events

Subscribe before submitting input so you receive every frame from the start of the turn. Save this as `subscribe.mjs` and run `node subscribe.mjs`:

```js
const { KAP, TOKEN, SESSION } = process.env;
const ws = new WebSocket(`${KAP.replace(/^http/, 'ws')}/api/v1/ws`, [
  `kimi-code.bearer.${TOKEN}`,
]);

ws.onopen = () => {
  ws.send(
    JSON.stringify({
      type: 'subscribe',
      request_id: 'sub-1',
      session_id: SESSION,
      agent_ids: ['main'],
    }),
  );
};

ws.onmessage = (frame) => {
  const event = JSON.parse(frame.data);
  if (event.type === 'ping') ws.send(JSON.stringify({ type: 'pong' }));
  console.log(event.type, event);
};
```

### 4. Submit a prompt

In another terminal, submit a prompt with a client-generated `prompt_id` for idempotent retries:

```sh
curl -s -X POST "$KAP/api/v1/sessions/$SESSION/prompts" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"prompt_id": "p-1", "content": [{"type": "text", "text": "Summarize this repository in one sentence"}]}'
```

The subscriber receives the initial state frames and `turns`, followed by `agent` (`running`), `turn.started`, streaming `item.started` / `item.delta` / `item.ended` frames, `turn.updated`, `turn.ended`, and `agent` (`idle`).

### 5. Page through earlier turns

The initial `turns` frame carries at most the latest 10 turns. When `has_more` is `true`, pass the `ordinal` of the earliest loaded turn (`FIRST_ORDINAL`) as `before_ordinal` to fetch older turns:

```sh
curl -s -H "Authorization: Bearer $TOKEN" \
  "$KAP/api/v1/sessions/$SESSION/agents/main/turns?before_ordinal=$FIRST_ORDINAL&page_size=20"
```

## Next steps

- [`kap.md` full protocol specification](https://code.kimi.com/kimi-code/kap.md) — general conventions, error codes, all REST endpoints, and WebSocket reduction rules
- [`kimi` command](../reference/kimi-command.md#kimi-web) — CLI flags for `kimi web` and `-p` non-interactive mode
- [Using in IDEs](./ides.md) — connect Zed and JetBrains IDEs via `kimi acp`

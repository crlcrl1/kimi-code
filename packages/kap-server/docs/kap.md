# Kimi Agent Protocol (KAP) Reference (Beta)

The local server started by `kimi web` (as well as the server embedded in the desktop app) exposes the **Kimi Agent Protocol (KAP)**: a pair of HTTP REST endpoints (`/api/v1`) and a WebSocket event stream (`/api/v1/ws`). Clients and scripts can use them to create sessions, submit prompts, stream live conversation turns and agent state, respond to approvals, and manage workspaces, models, plugins, and MCP servers. For startup flags and CLI options, see [kimi Command](https://moonshotai.github.io/kimi-code/en/reference/kimi-command.html#kimi-web).

> **Note:** This protocol is in Beta and may evolve across releases. A running server also serves machine-readable schemas generated directly from its live validation definitions at [`GET /openapi.json`](#address-and-online-schemas) and [`GET /asyncapi.json`](#address-and-online-schemas).
## Sections in this document

1. **Overview and Quick Start**: [Conventions](#conventions), [address and online schemas](#address-and-online-schemas), [authentication](#authentication), [response envelope](#response-envelope), [error codes](#error-codes), [pagination](#pagination), and a 5-step [quick start](#quick-start).
2. **[Sessions and Conversations](#sessions-and-conversations)**: Client protocol guide — connecting and subscribing, rendering a conversation turn (`Turn` / `Item`), submitting input and steering, stopping / undoing / compacting, approvals and questions, task output streaming, agent state, and global events. **Start here when building a client.**
3. **[Session Endpoints](#session-endpoints)**: Reference for all `/api/v1/sessions` REST endpoints (creating, listing and grouping sessions, batch archive/restore, profile settings, session actions, turn pagination, prompt queue, and interaction replies).
4. **[Service and Configuration Endpoints](#service-and-configuration-endpoints)**: Server metadata, OAuth login and usage, remote control, config, models and providers, workspaces, built-in capabilities and plugins, MCP management, file uploads, and global search.
5. **[File Endpoints](#file-endpoints)**: Session filesystem, workspace filesystem, host filesystem endpoints, and HTTP streaming/download semantics.

## Conventions

- **Forward compatibility**: Ignore unrecognized event types, item types, and fields without failing so clients stay compatible as the protocol adds capabilities.
- **Naming and time**: KAP-owned REST and WebSocket fields use `snake_case` (passthrough or legacy payloads — such as managed OAuth fields `limit5h`, `usedRatio`, `resetAt`, `userInfo`, `userId`, and the structured `40911` undo payload `{ reason, requestedCount, undoableCount }` — keep their documented `camelCase` keys); timestamps are ISO 8601 strings; durations end with `_ms` (milliseconds).
- **Opaque IDs**: `session_id`, `turn_id`, `item_id`, `interaction_id`, and `task_id` are opaque strings — do not parse their format. `turn_id` and `item_id` are derived deterministically from persisted engine records, so live events and paginated history return identical IDs.
- **Action paths and idempotency**: Non-CRUD operations on a resource or collection use a `:{action}` suffix with `POST`, such as `POST /api/v1/sessions/{session_id}:fork` or `POST /api/v1/sessions:archive`. Generate a session-unique `prompt_id` on the client when submitting input, and resend with the same `prompt_id` on network errors or timeouts.
- **Reading wire examples**: Protocol walkthrough blocks prefix each line by direction — `C` (WebSocket client → server), `S` (WebSocket server → client), `H` (HTTP request), and `R` (`data` inside the HTTP response envelope):

```text
C { "type": "task.watch", "request_id": "r2", "session_id": "s1", "agent_id": "main", "task_id": "bash-k3f9x2ab" }
S {"type": "response", "request_id": "r2", "code": 0}
H POST /api/v1/sessions/s1:cancel
R { "cancelled": true }
```

## Address and online schemas

The server listens on `http://127.0.0.1:58627` by default (probing up to 100 consecutive ports if busy; override with `--host` and `--port`, or pass `--port 0` to let the OS pick an ephemeral port).

A running server exposes two machine-readable specifications generated from its live validation schemas (both require authentication and return raw JSON documents rather than the `/api/v1` response envelope):

- `GET /openapi.json`: REST specification (OpenAPI 3.0)
- `GET /asyncapi.json`: WebSocket specification (AsyncAPI)

## Authentication

All `/api/*` paths, `/openapi.json`, and `/asyncapi.json` require a bearer token, except:

- `OPTIONS` preflight requests
- `GET /api/v1/healthz` (liveness probe)
- Static web assets outside `/api/`

Clients obtain `(origin, token)` either by launching `kimi web --no-open --port 0` and reading the bound URL and `Token` from its startup output, or by receiving `(origin, token)` directly from the embedding host (such as the desktop app or remote relay). Pass the token in the `Authorization: Bearer <token>` header for REST requests; WebSocket upgrade requests accept either that header or the subprotocol `kimi-code.bearer.<token>`.

Missing or invalid credentials return HTTP 401 (`code: 40101`); missing, malformed, or disallowed `Host` headers return HTTP 403 (`code: 40301`). When bound to a non-loopback address, 10 failed auth attempts from the same source within 60 seconds ban that source for 60 seconds, returning HTTP 429 (`code: 42901`).

## Response envelope

Every `/api/v1` JSON response (except `204` empty responses and binary streams) uses the same envelope:

```json
{
  "code": 0,
  "msg": "success",
  "data": {},
  "request_id": "01JZX4A6E7M8V0R3Q0N2K2M5Q9"
}
```

| Field | Description |
| --- | --- |
| `code` | Business status code: `0` on success, non-zero on error (see [Error codes](#error-codes)). Always check `code` first |
| `msg` | Status summary or error message |
| `data` | Response payload on success (the response fields documented for each endpoint describe `data`); `null` on error except `40911` (`:undo` boundary / count failure returns `{ reason, requestedCount, undoableCount }`) |
| `details` | Optional structured error context (e.g., field validation issues on `40001`, lock holder on `40931`, `model_id` on `40113`) |
| `request_id` | ULID for this request (clients may supply `X-Request-Id`) |

HTTP status is `200` for almost all responses; check `code` for the outcome. Exceptions:

| Scenario | HTTP status |
| --- | --- |
| Auth failure / disallowed `Host` header (or disallowed `Origin` on WebSocket upgrade; REST omits CORS headers instead) / rate limit | `401` / `403` / `429` |
| Creating a provider, `:import_catalog`, `:import_registry` | `201` (body is still the standard envelope) |
| Deleting a provider | `204` (empty body) |
| `GET /api/v1/files/{file_id}`, `GET /api/v1/fs:content`, and session file `:download` | `206` (Range) and `304` (ETag), with real `4xx` / `500` status codes on error (`POST /api/v1/sessions/{session_id}/export` still reports errors in an HTTP `200` envelope); see [Binary and streaming endpoints](#binary-and-streaming-endpoints) |

## Error codes

HTTP responses and WebSocket `response` frames share the same error codes:

| Range / Code | Meaning |
| --- | --- |
| `0` | Success |
| `40001` | Request validation failed (`details` lists each offending field) |
| `40003`–`40006` | Provider is OAuth-managed (`40003`), catalog entry cannot be imported (`40004`), custom registry unavailable (`40005`), duplicate workspace source folder (`40006`) |
| `40101` | Missing or invalid credential (HTTP 401) |
| `40301` | Missing, invalid, or disallowed `Host` header (HTTP 403) |
| `40110`–`40113` | No provider configured (`40110`), missing provider credential (`40111`), credential rejected (`40112`), model cannot be resolved (`40113`) |
| `40401`–`40421` | Session or agent not found (`40401`), prompt not found (`40402`), interaction not found or expired (`40404`), task not found (`40406`), file not found (`40407`), MCP server not found (`40408`), path not found (`40409`), workspace not found (`40410`), skill not found (`40415`), catalog entry not found (`40417`), capability not found (`40418`), plugin not found (`40419`), environment not found (`40420`), turn not found (`40421`) |
| `40901` / `40902` | Session or agent busy (`40901`), interaction already ended (`40902`) |
| `40910`–`40920` | Compaction unavailable (`40910`), turn cannot be undone (`40911`), skill not user-invocable (`40912`), goal state conflict (`40913`–`40918`, `40920`) |
| `40922`–`40935` | Query does not match `page_token` (`40922`), title generation unavailable (`40923`), capability install conflict (`40924`/`40925`), environment unavailable (`40926`), `prompt_id` reused with different payload (`40927`), remote control conflict (`40928`), MCP OAuth failed (`40929`), session written by newer server (`40930`), session occupied by another process (`40931`), session updated by another process (`40932`), task cannot be backgrounded (`40933`), plugin catalog changed (`40934`), cannot enter Tower mode (`40935`) |
| `41302`–`41305` | File exceeds 10 MiB (`41302`), remote directory too large (`41303`), path outside workspace (`41304`), search timed out (`41305`) |
| `42901` / `42902` | Auth failure ban (`42901`), file watch limit exceeded (`42902`) |
| `50001`–`50004` | Internal error (`50001`), persistence failure (`50003`), model catalog unavailable (`50004`) |
| `6xxxx` / `7xxxx` / `8xxxx` | Tool runtime, LLM provider, or MCP passthrough errors (`msg` preserves upstream message) |

### Cross-process concurrency (`40931` and `40932`)

Multiple clients connected to the same `kap-server` instance share live sessions in memory and never hit these codes. They appear only when separate processes (for example, a standalone CLI and the desktop embedded server) touch the same session on disk:

- **`40931` (session occupied)**: Another process is actively writing to the session (`details` identifies the holder). Retry once it finishes, or call [`POST /api/v1/sessions/{session_id}:takeover`](#post-api-v1-sessions-session-id-takeover) if the holding process crashed and left a stale lock.
- **`40932` (session stale)**: Another process modified the session. On prompt submission, skill activation, and compaction, the server automatically reloads the session, pushes fresh `turns` frames to subscribers, and runs the request; only `:undo` returns `40932` directly after reloading so the user can inspect the updated history before undoing.

## Pagination

List endpoints use three pagination styles:

- **`page_token` / `page` pagination**: [`GET /api/v1/sessions`](#get-api-v1-sessions) (both flat and `view=by_workspace`) and [`POST /api/v1/search`](#post-api-v1-search) issue an opaque `next_page_token` bound to the query parameters (changing filters mid-pagination returns `40922` / `40001`). `GET /api/v1/sessions` also accepts a stateless 1-based `page` number.
- **Turn `before_ordinal` pagination**: [`GET /api/v1/sessions/{session_id}/agents/{agent_id}/turns`](#get-api-v1-sessions-session-id-agents-agent-id-turns) pages backward by turn `ordinal`.
- **ID cursor pagination (`before_id` / `after_id`)**: Flat session lists accept `before_id` or `after_id` (mutually exclusive) plus `page_size`.

## Quick start

This 5-step walkthrough uses `curl` and a dependency-free Node.js script (Node.js 22+ includes a built-in `WebSocket` client) to create a session, subscribe to events, submit a prompt, stream the reply, and page backward through history.

### 1. Set environment variables

Start the server (`kimi web --no-open --port 0`) and set `KAP` and `TOKEN` from the bound `Local` origin (without `#token=...`) and `Token` printed in its startup output (or `http://127.0.0.1:58627` when running without `--port 0`):

```sh
export KAP="http://127.0.0.1:<port from startup output>"
export TOKEN="<Token from startup output>"
```

### 2. Create a session

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

### 3. Connect WebSocket and subscribe

Subscribe before submitting input so you receive every event from the start of the turn. Save this as `subscribe.mjs` and run `node subscribe.mjs`:

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

### 4. Submit input and watch the event stream

In another terminal, submit a prompt with a client-generated `prompt_id` for idempotent retries:

```sh
curl -s -X POST "$KAP/api/v1/sessions/$SESSION/prompts" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"prompt_id": "p-1", "content": [{"type": "text", "text": "Summarize this repository in one sentence"}]}'
```

Here is the complete sequence of frames from subscription through turn completion:

```text
C { "type": "subscribe", "request_id": "sub-1", "session_id": "s1", "agent_ids": ["main"] }
S {"type": "response", "request_id": "sub-1", "code": 0}
S {"type": "task.list", "session_id": "s1", "agent_id": "main", "tasks": []}
S {"type": "agent", "event_created_at": "2026-10-29T10:30:00.000Z", "session_id": "s1", "agent_id": "main", "status": "idle", "compacting": false, "model": "kimi-for-coding", "thinking": "high", "permission_mode": "manual", "plan_mode": false, "swarm_mode": false, "tower_mode": false}
S {"type": "goal", "event_created_at": "2026-10-29T10:30:00.000Z", "session_id": "s1", "agent_id": "main"}
S {"type": "todo", "event_created_at": "2026-10-29T10:30:00.000Z", "session_id": "s1", "agent_id": "main", "items": []}
S {"type": "turns", "event_created_at": "2026-10-29T10:30:00.000Z", "session_id": "s1", "agent_id": "main", "turns": [], "has_more": false}
H POST /api/v1/sessions/s1/prompts
  { "prompt_id": "p-1", "content": [ { "type": "text", "text": "Summarize this repository in one sentence" } ] }
R { "prompt_id": "p-1", "user_message_id": "u_1", "status": "running", "content": [ { "type": "text", "text": "Summarize this repository in one sentence" } ], "created_at": "2026-10-29T10:30:00.000Z" }
S {"type": "agent", "event_created_at": "2026-10-29T10:30:00.000Z", "session_id": "s1", "agent_id": "main", "status": "running", "compacting": false, "model": "kimi-for-coding", "thinking": "high", "permission_mode": "manual", "plan_mode": false, "swarm_mode": false, "tower_mode": false}
S {"type": "turn.started", "event_created_at": "2026-10-29T10:30:00.000Z", "session_id": "s1", "agent_id": "main", "turn": {"turn_id": "t_1", "ordinal": 0, "turn_number": 0, "kind": "agent", "status": "running", "started_at": "2026-10-29T10:30:00.000Z", "steps": []}}
S {"type": "item.ended", "event_created_at": "2026-10-29T10:30:00.000Z", "session_id": "s1", "agent_id": "main", "turn_id": "t_1", "item": {"item_id": "u_1", "type": "user_message", "status": "ended", "outcome": "completed", "created_at": "2026-10-29T10:30:00.000Z", "prompt_ids": ["p-1"], "placement": "opener", "origin": {"kind": "user"}, "text": "Summarize this repository in one sentence", "attachments": [], "skills": []}}
S {"type": "item.started", "event_created_at": "2026-10-29T10:30:00.000Z", "session_id": "s1", "agent_id": "main", "turn_id": "t_1", "item": {"item_id": "a_1", "type": "assistant_message", "step_index": 1, "status": "running", "created_at": "2026-10-29T10:30:00.500Z", "text": ""}}
S {"type": "item.delta", "event_created_at": "2026-10-29T10:30:00.000Z", "session_id": "s1", "agent_id": "main", "turn_id": "t_1", "item_id": "a_1", "field": "text", "delta": "This is the core Kimi Code monorepo."}
S {"type": "item.ended", "event_created_at": "2026-10-29T10:30:00.000Z", "session_id": "s1", "agent_id": "main", "turn_id": "t_1", "item": {"item_id": "a_1", "type": "assistant_message", "step_index": 1, "status": "ended", "outcome": "completed", "created_at": "2026-10-29T10:30:00.500Z", "text": "This is the core Kimi Code monorepo."}}
S {"type": "turn.updated", "event_created_at": "2026-10-29T10:30:00.000Z", "session_id": "s1", "agent_id": "main", "turn_id": "t_1", "step": {"index": 1, "outcome": "completed", "finish_reason": "stop", "started_at": "2026-10-29T10:30:00.400Z", "ended_at": "2026-10-29T10:30:01.800Z"}}
S {"type": "turn.ended", "event_created_at": "2026-10-29T10:30:00.000Z", "session_id": "s1", "agent_id": "main", "turn": {"turn_id": "t_1", "ordinal": 0, "turn_number": 0, "kind": "agent", "status": "ended", "outcome": "completed", "started_at": "2026-10-29T10:30:00.000Z", "ended_at": "2026-10-29T10:30:01.800Z", "duration_ms": 1800, "steps": [{"index": 1, "outcome": "completed", "finish_reason": "stop", "started_at": "2026-10-29T10:30:00.400Z", "ended_at": "2026-10-29T10:30:01.800Z"}]}}
S {"type": "agent", "event_created_at": "2026-10-29T10:30:00.000Z", "session_id": "s1", "agent_id": "main", "status": "idle", "compacting": false, "model": "kimi-for-coding", "thinking": "high", "permission_mode": "manual", "plan_mode": false, "swarm_mode": false, "tower_mode": false}
```

### 5. Page backward through earlier turns

The initial `turns` frame carries at most the latest 10 turns. When `has_more` is `true` and the user scrolls up, pass the `ordinal` of the earliest locally loaded turn (`FIRST_ORDINAL`) as `before_ordinal` to fetch older turns (the returned `Turn` objects have the exact same shape as the WebSocket stream):

```sh
curl -s -H "Authorization: Bearer $TOKEN" \
  "$KAP/api/v1/sessions/$SESSION/agents/main/turns?before_ordinal=$FIRST_ORDINAL&page_size=20"
```

---

# Sessions and conversations

Clients receive live conversation turns, agent state frames, interaction requests, and task output over a single WebSocket connection (`/api/v1/ws`), and use REST endpoints (`/api/v1`) to submit input, answer approvals, stop, or undo. This section follows the lifecycle a client implements: every subsection pairs a complete wire trace with concise client reduction rules. For REST parameter tables, see [Session Endpoints](#session-endpoints); for authentication, envelopes, and error codes, see [Overview](#kimi-agent-protocol-kap-reference-beta).

## Connecting

The WebSocket endpoint is `ws://<host>:<port>/api/v1/ws`. Authentication happens during the HTTP upgrade handshake via `Authorization: Bearer <token>` or the subprotocol `kimi-code.bearer.<token>` (see [Authentication](#authentication)).

There is no handshake frame. Once connected, the client immediately receives [global events](#global-events) and can send commands right away.

### Heartbeat

| Direction | Rule |
| --- | --- |
| Server → Client | Sends `{ "type": "ping" }` every 10 seconds; the client replies with `{ "type": "pong" }` |
| Server timeout | Checks every 10 seconds on a monotonic clock and closes connections silent for 20 seconds with code `1001` (`heartbeat timeout`, occurring after 20–30 seconds of silence) |
| Client timeout | If no frame arrives for 25 seconds (also checked immediately when a background tab becomes visible or network connectivity returns), disconnect and reconnect as described in [Reconnecting](#reconnecting) |

```text
C { "type": "pong" }
```

Any valid inbound JSON frame with a string `type` counts as client activity; invalid JSON or frames without `type` are ignored. The server times heartbeats on a monotonic clock (unaffected by wall-clock adjustments or system sleep); if the server's own event loop stalls for more than 12.5 seconds, it sends a fresh `ping` and grants a new 20-second window, draining already-buffered socket messages before closing.

### Commands and responses

Client WebSocket commands are flat JSON frames and must include a non-empty `request_id` (missing `request_id` on a known command closes the socket with code `1008`). For every command listed in the table below, the server replies with a `response` frame; unrecognized `type` values are ignored without sending a `response` (though any valid JSON frame with a string `type` still counts as heartbeat activity):

```text
C { "type": "subscribe", "request_id": "sub-1", "session_id": "s1", "agent_ids": ["main"] }
S {"type": "response", "request_id": "sub-1", "code": 0}
C { "type": "subscribe", "request_id": "sub-2", "session_id": "s404" }
S {"type": "response", "request_id": "sub-2", "code": 40401, "msg": "session not found"}
```

`subscribe` and `unsubscribe` commands on the same connection run sequentially in send order; task commands (`task.*`) serialize per task without blocking subscriptions. Conversation, interaction, task-state (`task`), agent-state (`agent`, `context`, `goal`, `todo`), and global event frames carry an ISO 8601 `event_created_at` timestamp (`response`, `ping` / `pong`, `task.list`, and `task.output` do not).

| Command | Fields | Purpose |
| --- | --- | --- |
| `subscribe` | `request_id`, `session_id`, `agent_ids?` | Subscribe to a session (defaults to `["main"]`); sending `subscribe` again adds agents incrementally |
| `unsubscribe` | `request_id`, `session_id`, `agent_ids?` | Stop receiving the listed agents, or the entire session when `agent_ids` is omitted or the last agent is removed |
| `task.watch` | `request_id`, `session_id`, `agent_id`, `task_id`, `since_offset?`, `tail_bytes?` | Stream a task's output; the `response` includes the current `task` state |
| `task.unwatch` | `request_id`, `session_id`, `agent_id`, `task_id` | Stop streaming task output |
| `task.stop` | `request_id`, `session_id`, `agent_id`, `task_id` | Stop a running task; the `response` includes the updated `task` state |
| `task.background` | `request_id`, `session_id`, `agent_id`, `task_id` | Detach a foreground task into the background; the `response` includes the updated `task` state |

## Subscribing to a session

Besides the main agent (`main`), a session can contain subagents, swarm members, and side chats (`btw`), each with its own conversation and state. The walkthrough below shows opening a session, receiving its initial state, and expanding/collapsing a subagent panel:


#### Subscribe to a session and receive initial content
The user opens session `s1`. Upon receiving a successful `response`, the client clears its local state for `s1` and applies the pending interactions, running task list, agent state frames, and the latest page of `turns`:

```text
C { "type": "subscribe", "request_id": "sub-1", "session_id": "s1", "agent_ids": ["main"] }
S {"type": "response", "request_id": "sub-1", "code": 0}
S {"type": "interaction", "event_created_at": "2026-10-29T10:30:00.000Z", "session_id": "s1", "agent_id": "sub_7", "interaction_id": "i12", "kind": "approval", "status": "pending", "tool_call_id": "c7", "request": {"tool_name": "Bash", "action": "Run command", "expires_at": "2026-10-30T10:30:00.000Z"}}
S {"type": "task.list", "session_id": "s1", "agent_id": "main", "tasks": [{"task_id": "task-7q2m", "kind": "subagent", "status": "running", "phase": "working", "detached": false, "description": "Find call sites", "child_agent_id": "sub_7", "parent_tool_call_id": "call_agent_1", "started_at": "2026-10-29T10:29:50.000Z"}]}
S {"type": "agent", "event_created_at": "2026-10-29T10:30:00.000Z", "session_id": "s1", "agent_id": "main", "status": "running", "compacting": false, "model": "kimi-for-coding", "thinking": "high", "permission_mode": "manual", "plan_mode": false, "swarm_mode": false, "tower_mode": false}
S {"type": "context", "event_created_at": "2026-10-29T10:30:00.000Z", "session_id": "s1", "agent_id": "main", "context_tokens": 18210, "max_context_tokens": 262144}
S {"type": "goal", "event_created_at": "2026-10-29T10:30:00.000Z", "session_id": "s1", "agent_id": "main"}
S {"type": "todo", "event_created_at": "2026-10-29T10:30:00.000Z", "session_id": "s1", "agent_id": "main", "items": []}
S {"type": "turns", "event_created_at": "2026-10-29T10:30:00.000Z", "session_id": "s1", "agent_id": "main", "turns": [{"turn_id": "t_9", "ordinal": 9, "turn_number": 9, "kind": "agent", "status": "running", "started_at": "2026-10-29T10:29:45.000Z", "steps": [], "items": []}], "has_more": true}
```

Even though only `main` is in `agent_ids`, the approval `i12` requested by subagent `sub_7` still arrives (`interaction` frames are session-wide and bypass `agent_ids`), while `sub_7`'s running status and description appear on `main`'s subagent entry in `task.list`.

#### Expand and collapse a subagent panel
When the user expands `sub_7`, send an incremental `subscribe` with `agent_ids: ["sub_7"]` (already-subscribed `main` does not resend `turns`); when collapsing the panel, unsubscribe `sub_7`:

```text
C { "type": "subscribe", "request_id": "sub-2", "session_id": "s1", "agent_ids": ["sub_7"] }
S {"type": "response", "request_id": "sub-2", "code": 0}
S {"type": "task.list", "session_id": "s1", "agent_id": "sub_7", "tasks": []}
S {"type": "agent", "event_created_at": "2026-10-29T10:30:00.000Z", "session_id": "s1", "agent_id": "sub_7", "status": "running", "compacting": false, "model": "kimi-for-coding", "plan_mode": false, "swarm_mode": false, "tower_mode": false}
S {"type": "todo", "event_created_at": "2026-10-29T10:30:00.000Z", "session_id": "s1", "agent_id": "sub_7", "items": []}
S {"type": "turns", "event_created_at": "2026-10-29T10:30:00.000Z", "session_id": "s1", "agent_id": "sub_7", "turns": [], "has_more": false}
... User collapses the subagent panel
C { "type": "unsubscribe", "request_id": "unsub-1", "session_id": "s1", "agent_ids": ["sub_7"] }
S {"type": "response", "request_id": "unsub-1", "code": 0}
```



Frame ordering on subscription:

1. **Reply (`response`)**: Always arrives first. If the session cannot be opened, `code` is non-zero (`40401`, `40930`, `40931`) and no subscription is created.
2. **Pending interactions (`interaction`)**: Sent immediately after `response` for all unresolved approvals and questions in the session. Every successful `subscribe` resends all pending interactions so the client can replace its local interaction list.
3. **Tasks and state (`task.list`, `agent`, `context`, `goal`, `todo`)**: Sent for each newly subscribed agent. Subscribing to a brand-new session materializes `main` automatically.
4. **Conversation page (`turns` or `turns.failed`)**: Loaded asynchronously from disk (up to the latest 10 turns within 1 MiB) and may arrive after live state frames, but **live conversation frames (`turn.*`, `item.*`, `turns.removed`, `notice`) for an agent never arrive before its `turns` frame** — frames produced during loading are buffered and flushed in order right after `turns`.

### When the server closes and reopens a session

The server reclaims sessions idle for 30 minutes (`KIMI_CODE_SESSION_IDLE_RECLAIM_MS`) when they have no running turn, pending interaction, or cron job; `:reload` also closes and reopens a session.

- **Idle reclaim and reload**: Subscriptions remain active across close/reopen. When the session reopens, the server resends `task.list`, state frames, and `turns` for every subscribed agent. Whenever a client receives `turns`, it replaces the latest turns for that agent.
- **Archive or delete**: Archiving or deleting a session removes all subscriptions and broadcasts the corresponding global event. After restoring an archived session, send `subscribe` again.

### Who receives which frames

| Frame category | Recipients |
| --- | --- |
| [Global events](#global-events) | Every open WebSocket connection (no subscription needed) |
| `interaction` | Every connection subscribed to the session, **regardless of `agent_ids`** |
| `turns`, `turns.removed`, `turns.failed`, `turn.*`, `item.*`, `notice` | Connections subscribed to the session whose `agent_ids` include `agent_id` |
| `task.list`, `task`, `agent`, `context`, `goal`, `todo` | Same as above |
| `task.output` | Connections watching that task via `task.watch` (no session subscription needed) |

### Frame ordering

- Frames for the same session share one outbound queue (flushed every 16 ms or 64 frames; `response` and `interaction` flush immediately without overtaking queued frames).
- When a turn finishes, `turn.ended` always precedes the `agent` frame with `status: "idle"` (unless the initial `turns` page is still loading).
- HTTP responses and WebSocket frames travel over separate channels and may arrive in either order. Match them by `prompt_id`, `turn_id`, or `interaction_id`.

## Conversation

An agent's conversation is an ordered list of **turns (`Turn`)**, each containing an ordered list of **items (`Item`)**. The walkthrough below shows a complete turn (user message, reasoning, tool call, assistant reply) followed by a turn that retries an upstream error and fails:


#### Turn start and user message

```text
S {"type": "turn.started", "event_created_at": "2026-10-29T10:30:00.000Z", "session_id": "s1", "agent_id": "main", "turn": {"turn_id": "t_1", "ordinal": 0, "turn_number": 0, "kind": "agent", "status": "running", "started_at": "2026-10-29T10:30:00.000Z", "steps": []}}
S {"type": "item.ended", "event_created_at": "2026-10-29T10:30:00.000Z", "session_id": "s1", "agent_id": "main", "turn_id": "t_1", "item": {"item_id": "u_1", "type": "user_message", "status": "ended", "outcome": "completed", "created_at": "2026-10-29T10:30:00.000Z", "prompt_ids": ["p-1"], "placement": "opener", "origin": {"kind": "user"}, "text": "Does the start command in README still work?", "attachments": [], "skills": []}}
```

#### Reasoning and tool call (Step 1)

```text
S {"type": "item.started", "event_created_at": "2026-10-29T10:30:00.000Z", "session_id": "s1", "agent_id": "main", "turn_id": "t_1", "item": {"item_id": "r_1", "type": "reasoning", "step_index": 1, "status": "running", "created_at": "2026-10-29T10:30:00.400Z", "text": "", "started_at": "2026-10-29T10:30:00.400Z"}}
S {"type": "item.delta", "event_created_at": "2026-10-29T10:30:00.000Z", "session_id": "s1", "agent_id": "main", "turn_id": "t_1", "item_id": "r_1", "field": "text", "delta": "Let's read README.md first"}
S {"type": "item.started", "event_created_at": "2026-10-29T10:30:00.000Z", "session_id": "s1", "agent_id": "main", "turn_id": "t_1", "item": {"item_id": "call_read_1", "type": "tool_call", "step_index": 1, "status": "running", "created_at": "2026-10-29T10:30:01.700Z", "name": "Read", "stage": "input", "started_at": "2026-10-29T10:30:01.700Z"}}
S {"type": "item.delta", "event_created_at": "2026-10-29T10:30:00.000Z", "session_id": "s1", "agent_id": "main", "turn_id": "t_1", "item_id": "call_read_1", "field": "input_text", "delta": "{\"path\":\"README.md\"}"}
S {"type": "item.ended", "event_created_at": "2026-10-29T10:30:00.000Z", "session_id": "s1", "agent_id": "main", "turn_id": "t_1", "item": {"item_id": "r_1", "type": "reasoning", "step_index": 1, "status": "ended", "outcome": "completed", "created_at": "2026-10-29T10:30:00.400Z", "text": "Let's read README.md first to check the script.", "started_at": "2026-10-29T10:30:00.400Z", "duration_ms": 1200}}
S {"type": "item.updated", "event_created_at": "2026-10-29T10:30:00.000Z", "session_id": "s1", "agent_id": "main", "turn_id": "t_1", "item_id": "call_read_1", "set": {"stage": "executing", "input": {"path": "README.md"}}}
S {"type": "item.ended", "event_created_at": "2026-10-29T10:30:00.000Z", "session_id": "s1", "agent_id": "main", "turn_id": "t_1", "item": {"item_id": "call_read_1", "type": "tool_call", "step_index": 1, "status": "ended", "outcome": "completed", "created_at": "2026-10-29T10:30:01.700Z", "name": "Read", "stage": "executing", "input": {"path": "README.md"}, "output": "1\t# App\n2\tRun `pnpm dev`", "started_at": "2026-10-29T10:30:01.700Z", "ended_at": "2026-10-29T10:30:02.100Z"}}
S {"type": "turn.updated", "event_created_at": "2026-10-29T10:30:00.000Z", "session_id": "s1", "agent_id": "main", "turn_id": "t_1", "step": {"index": 1, "outcome": "completed", "finish_reason": "tool_calls", "started_at": "2026-10-29T10:30:00.300Z", "ended_at": "2026-10-29T10:30:02.100Z", "usage": {"input_other": 5210, "output": 96, "input_cache_read": 0, "input_cache_creation": 0}}}
```

#### Assistant reply and turn completion (Step 2)

```text
S {"type": "item.started", "event_created_at": "2026-10-29T10:30:00.000Z", "session_id": "s1", "agent_id": "main", "turn_id": "t_1", "item": {"item_id": "a_1", "type": "assistant_message", "step_index": 2, "status": "running", "created_at": "2026-10-29T10:30:02.400Z", "text": ""}}
S {"type": "item.delta", "event_created_at": "2026-10-29T10:30:00.000Z", "session_id": "s1", "agent_id": "main", "turn_id": "t_1", "item_id": "a_1", "field": "text", "delta": "Yes, `pnpm dev` in README matches package.json."}
S {"type": "item.ended", "event_created_at": "2026-10-29T10:30:00.000Z", "session_id": "s1", "agent_id": "main", "turn_id": "t_1", "item": {"item_id": "a_1", "type": "assistant_message", "step_index": 2, "status": "ended", "outcome": "completed", "created_at": "2026-10-29T10:30:02.400Z", "text": "Yes, `pnpm dev` in README matches package.json."}}
S {"type": "turn.updated", "event_created_at": "2026-10-29T10:30:00.000Z", "session_id": "s1", "agent_id": "main", "turn_id": "t_1", "step": {"index": 2, "outcome": "completed", "finish_reason": "stop", "started_at": "2026-10-29T10:30:02.200Z", "ended_at": "2026-10-29T10:30:04.200Z"}}
S {"type": "turn.ended", "event_created_at": "2026-10-29T10:30:00.000Z", "session_id": "s1", "agent_id": "main", "turn": {"turn_id": "t_1", "ordinal": 0, "turn_number": 0, "kind": "agent", "status": "ended", "outcome": "completed", "started_at": "2026-10-29T10:30:00.000Z", "ended_at": "2026-10-29T10:30:04.200Z", "duration_ms": 4200, "steps": [{"index": 1, "outcome": "completed", "finish_reason": "tool_calls", "started_at": "2026-10-29T10:30:00.300Z", "ended_at": "2026-10-29T10:30:02.100Z", "usage": {"input_other": 5210, "output": 96, "input_cache_read": 0, "input_cache_creation": 0}}, {"index": 2, "outcome": "completed", "finish_reason": "stop", "started_at": "2026-10-29T10:30:02.200Z", "ended_at": "2026-10-29T10:30:04.200Z"}]}}
```

#### Provider error, retry countdown, and failed turn
When an LLM request hits a retryable error, `turn.updated` carries `retry` (and `item.removed` drops any partial reply from the failed attempt before the retry starts). If retries are exhausted, the turn ends with `outcome: "failed"`:

```text
S {"type": "turn.updated", "event_created_at": "2026-10-29T10:30:00.000Z", "session_id": "s1", "agent_id": "main", "turn_id": "t_2", "retry": {"attempt": 1, "next_attempt": 2, "max_attempts": 3, "delay_ms": 2000, "error": {"name": "ProviderError", "message": "upstream overloaded", "status_code": 529}}}
S {"type": "turn.ended", "event_created_at": "2026-10-29T10:30:00.000Z", "session_id": "s1", "agent_id": "main", "turn": {"turn_id": "t_2", "ordinal": 1, "turn_number": 1, "kind": "agent", "status": "ended", "outcome": "failed", "end_reason": "error", "error": {"code": "provider.overloaded", "message": "Provider overloaded, please try again later", "status_code": 529, "retryable": true}, "started_at": "2026-10-29T10:31:00.000Z", "ended_at": "2026-10-29T10:31:08.000Z", "steps": []}}
```



### Turns

| Field | Description |
| --- | --- |
| `turn_id` | Session-unique ID; never reused after an undo |
| `ordinal` | Zero-based position in the agent's current history; sort turns by `ordinal` and pass it as `before_ordinal` when paging backward |
| `turn_number` | Engine turn number used by the [file history endpoints](#get-api-v1-sessions-session-id-file-history-changes) |
| `kind` | `agent` (normal turn) or `system` (a turn containing a single `system` item between turns, such as manual compaction or a fork boundary) |
| `status` | `running` or `ended` |
| `outcome` | Present when `status` is `ended`: `completed`, `interrupted`, or `failed` |
| `end_reason` | When `interrupted`: `user_cancelled` or `aborted`; when `failed`: `error`, `max_steps`, `filtered`, or `blocked` |
| `error` | On failed turns: `{ code, message, name?, status_code?, request_id?, retryable? }` |
| `retry` | On running turns waiting to retry: `{ attempt, next_attempt, max_attempts, delay_ms, error: { name, message, status_code? } }` |
| `started_at`, `ended_at?`, `duration_ms?` | Timestamps and duration in milliseconds |
| `usage` | Sum of step token usage: `{ input_other, output, input_cache_read, input_cache_creation }` |
| `steps` | Finished steps: `{ index, outcome, started_at, ended_at?, finish_reason?, usage? }` |
| `items` | Ordered items in the turn (`turn.started` and `turn.ended` omit `items`; keep existing items for that turn) |

### Items

Every item shares these base fields:

| Field | Description |
| --- | --- |
| `item_id` | Item ID (for `tool_call`, this is the tool call ID) |
| `type` | `user_message` / `reasoning` / `assistant_message` / `tool_call` / `notification` / `system` |
| `step_index` | Step number that produced the item |
| `status` | `running` or `ended` |
| `outcome` | Present when `status` is `ended`: `completed`, `interrupted`, or `failed` |
| `created_at` | Creation timestamp (ISO 8601) |
| `debug` | Attached to the last item of each finished step when `KIMI_CODE_DEBUG=1`: `{ finish_reason?, usage?, timing?: { first_token_ms?, stream_ms?, request_build_ms?, server_first_token_ms?, server_decode_ms?, client_consume_ms?, client_blocked_ms? } }` |

#### `user_message`

| Field | Description |
| --- | --- |
| `prompt_ids` | Client `prompt_id` values carried by this message (multiple steers merged at the same point list all of their IDs). Retire local optimistic bubbles whose `prompt_id` appears in `prompt_ids` |
| `placement` | `opener` (started the turn) or `steer` (inserted into a running turn) |
| `origin` | `{ kind: "user" }`, `{ kind: "skill", name, path?, args? }`, `{ kind: "plugin_command", plugin_id, command, args? }`, `{ kind: "cron", job_id, schedule, recurring, coalesced_count, stale }`, `{ kind: "hook", hook_event }`, `{ kind: "goal" }`, `{ kind: "retry" }`, or `{ kind: "system" }` |
| `text` | User-visible text (strips system-injected attachment notices, image compression notes, and bundled skill bodies) |
| `attachments` | `{ kind: "image" \| "video" \| "audio" \| "file", file_id?, url?, name?, media_type?, size?, ordinal }[]` |
| `skills` | Bundled skills: `{ name, path?, args? }[]` |
| `metadata` | Echoes the custom `metadata` submitted with the prompt |

#### `assistant_message` and `reasoning`

- **`assistant_message`**: `{ text }`, the model's reply.
- **`reasoning`**: `{ text, started_at, duration_ms? }`, the model's reasoning output (`duration_ms` is populated once `ended`).

#### `tool_call`

| Field | Description |
| --- | --- |
| `name` | Tool name (e.g., `Bash`, `Read`, `Edit`, `Agent`, `ExitPlanMode`) |
| `stage` | `input` (streaming arguments) → `awaiting_approval` (waiting for user decision) → `executing` |
| `input`, `input_text` | Parsed input object and raw argument text streamed during `stage: "input"` |
| `output`, `error` | Streaming output and normal result text in `output`; failure (`failed`) or stop (`interrupted`) output (including partial output before the stop) in `error` |
| `fields`, `media`, `note` | Handler field snapshot, media attachments (`{ kind, file_id?, url?, media_type? }`), and model note |
| `task_id` | Task ID when the tool runs as (or is detached to) a background task; use with `task.watch` / `task.stop` |
| `interaction_id` | Associated approval or question ID (matches [`interaction`](#approvals-and-questions)) |
| `agent_refs` | Spawned subagents or swarm members: `{ agent_id, role: "child" \| "member", swarm_index?, task_id? }[]` |
| `display` | For `ExitPlanMode`: `{ kind: "plan_review", plan, path?, options, review }` |
| `started_at`, `ended_at?` | Start and end timestamps |

#### `notification`

Background task notification delivered into the conversation: `{ notification_id, title, body, severity: "info" \| "warning" \| "error", notification_type, source: { kind, id }, task_id?, agent_id?, output?: { file?, preview?, bytes?, truncated? }, answer?: { answers: Record<string, string \| true>, note?: string } }`.

#### `system`

| `kind` | Extra fields | Description |
| --- | --- | --- |
| `compaction` | `trigger: "manual" \| "auto"`, `instruction?`, `tokens_before?`, `tokens_after?`, `compacted_count?`, `summary?` | Completed context compaction divider |
| `fork_boundary` | `source: "btw" \| "fork"`, `forked_from: { agent_id }` | Opening boundary of a forked or side-chat (`btw`) agent |

### Live updates

Clients reduce conversation frames with these rules:

| Frame | Payload | Client action |
| --- | --- | --- |
| `turns` | `turns: Turn[]`, `has_more: boolean` | Sent on subscribe or session reopen; replaces the latest turns for that agent |
| `turns.failed` | `code: number`, `msg: string` | Initial conversation load failed (the subscription remains active; show an error state and replace it if a later `turns` frame arrives) |
| `turn.started`, `turn.ended` | `turn` (without `items`) | Insert or update the turn header by `turn_id`, preserving its existing `items`; sort turns by `ordinal` |
| `turn.updated` | `turn_id`, `step?`, `retry?` | Write `step` into `turn.steps` by `index`; replace `turn.retry` (or clear it when omitted) |
| `item.started`, `item.ended` | `turn_id`, `item` | Replace the item with matching `(turn_id, item_id)` in place, or append to `turn.items` if new |
| `item.delta` | `turn_id`, `item_id`, `field`, `delta` | Append `delta` to `item[field]` (`text`, `input_text`, or `output`) |
| `item.updated` | `turn_id`, `item_id`, `set` | Shallow-merge `set` onto the item |
| `item.removed` | `turn_id`, `item_id` | Remove the item from the turn (used when a retried step discards its partial reply) |
| `turns.removed` | `turn_ids: string[]` | Delete the listed turns by `turn_id` and discard any in-flight pagination requests sent before this frame |
| `notice` | `{ level, title, detail?, code? }` | Show a transient toast/banner (e.g., `compaction.cancelled`); do not insert into turns |

## Submitting input

Submit user input with [`POST /api/v1/sessions/{session_id}/prompts`](#post-api-v1-sessions-session-id-prompts). The walkthrough below shows submitting while idle, queueing while busy and converting to a steer, and retrying idempotently after a timeout:


#### Submit while idle: starts a new turn immediately

```text
H POST /api/v1/sessions/s1/prompts
  { "prompt_id": "p-1", "content": [ { "type": "text", "text": "Investigate this error" } ] }
R { "prompt_id": "p-1", "user_message_id": "u_1", "status": "running", "content": [ { "type": "text", "text": "Investigate this error" } ], "created_at": "2026-10-29T10:35:00.000Z" }
S {"type": "turn.started", "event_created_at": "2026-10-29T10:30:00.000Z", "session_id": "s1", "agent_id": "main", "turn": {"turn_id": "t_1", "ordinal": 0, "turn_number": 0, "kind": "agent", "status": "running", "started_at": "2026-10-29T10:35:00.000Z", "steps": []}}
S {"type": "item.ended", "event_created_at": "2026-10-29T10:30:00.000Z", "session_id": "s1", "agent_id": "main", "turn_id": "t_1", "item": {"item_id": "u_1", "type": "user_message", "status": "ended", "outcome": "completed", "created_at": "2026-10-29T10:35:00.000Z", "prompt_ids": ["p-1"], "placement": "opener", "origin": {"kind": "user"}, "text": "Investigate this error", "attachments": [], "skills": []}}
```

#### Submit while busy: queued, then steered into the active turn

```text
H POST /api/v1/sessions/s1/prompts
  { "prompt_id": "p-2", "content": [ { "type": "text", "text": "Also check lint" } ] }
R { "prompt_id": "p-2", "user_message_id": "u_2", "status": "queued", "content": [ { "type": "text", "text": "Also check lint" } ], "created_at": "2026-10-29T10:35:10.000Z" }
H POST /api/v1/sessions/s1/prompts:steer
  { "prompt_ids": ["p-2"] }
R { "steered": true, "prompt_ids": ["p-2"] }
... Current step finishes; steer is injected at the next boundary
S {"type": "item.ended", "event_created_at": "2026-10-29T10:30:00.000Z", "session_id": "s1", "agent_id": "main", "turn_id": "t_1", "item": {"item_id": "u_2", "type": "user_message", "status": "ended", "outcome": "completed", "created_at": "2026-10-29T10:35:12.000Z", "prompt_ids": ["p-2"], "placement": "steer", "origin": {"kind": "user"}, "text": "Also check lint", "attachments": [], "skills": []}}
```

#### Network timeout: resend with the same `prompt_id`

```text
H POST /api/v1/sessions/s1/prompts
  { "prompt_id": "p-3", "content": [ { "type": "text", "text": "Run unit tests too" } ] }
... Request times out; client resends the exact same payload and prompt_id
H POST /api/v1/sessions/s1/prompts
  { "prompt_id": "p-3", "content": [ { "type": "text", "text": "Run unit tests too" } ] }
R { "prompt_id": "p-3", "user_message_id": "u_3", "status": "queued", "content": [ { "type": "text", "text": "Run unit tests too" } ], "created_at": "2026-10-29T10:35:20.000Z" }
```



### Starting or queueing

- **Immediate turn**: When the target agent is idle, its queue is empty, and no undo, compaction, or fork is running, the submission starts a turn immediately and returns `status: "running"` (or `blocked` / `failed` if rejected by a hook before starting).
- **Queued**: Otherwise (including during undo, compaction, or fork), the submission enters the queue and returns `status: "queued"` immediately. Read `main`'s active and queued prompts with [`GET /api/v1/sessions/{session_id}/prompts`](#get-api-v1-sessions-session-id-prompts).

### Retries and idempotency

Generate a session-unique `prompt_id` on the client for every submission:

- Resending the same `prompt_id` with an identical body returns the original response (or waits for an in-flight first request) without duplicating the prompt or re-applying overrides.
- Reusing a `prompt_id` with a different body or across `/prompts`, `/steer`, and `skills/{name}:activate` returns `40927`.

### Steering

To inject input into a running turn before it finishes:

- **Direct steer**: Call [`POST /api/v1/sessions/{session_id}/steer`](#post-api-v1-sessions-session-id-steer) with the same body as `/prompts`.
- **Steer queued prompts**: Call [`POST /api/v1/sessions/{session_id}/prompts:steer`](#post-api-v1-sessions-session-id-prompts-steer) with `prompt_ids`. Once inserted, the prompt appears in the turn as a `user_message` with `placement: "steer"`.

## Stopping, undoing, and compacting

The walkthrough below shows stopping a running turn, undoing turns, running manual compaction, and starting a read-only side chat (`btw`):


#### Withdraw a queued prompt and cancel the active turn (`:cancel`)

```text
H POST /api/v1/sessions/s1/prompts/p-9:abort
R { "aborted": true }
H POST /api/v1/sessions/s1:cancel
R { "cancelled": true }
S {"type": "item.ended", "event_created_at": "2026-10-29T10:30:00.000Z", "session_id": "s1", "agent_id": "main", "turn_id": "t_3", "item": {"item_id": "call_bash_1", "type": "tool_call", "step_index": 1, "status": "ended", "outcome": "interrupted", "created_at": "2026-10-29T10:36:00.000Z", "name": "Bash", "stage": "executing", "error": "partial output...\n[Command interrupted by user]", "started_at": "2026-10-29T10:36:00.000Z", "ended_at": "2026-10-29T10:36:02.000Z"}}
S {"type": "turn.ended", "event_created_at": "2026-10-29T10:30:00.000Z", "session_id": "s1", "agent_id": "main", "turn": {"turn_id": "t_3", "ordinal": 2, "turn_number": 2, "kind": "agent", "status": "ended", "outcome": "interrupted", "end_reason": "user_cancelled", "started_at": "2026-10-29T10:35:50.000Z", "ended_at": "2026-10-29T10:36:02.000Z", "steps": []}}
```

#### Undo turn `t_5` and all subsequent turns (`:undo`)

```text
H POST /api/v1/sessions/s1:undo
  { "turn_id": "t_5" }
R { "removed_turn_ids": ["t_5", "t_6", "t_7"] }
S {"type": "turns.removed", "event_created_at": "2026-10-29T10:30:00.000Z", "session_id": "s1", "agent_id": "main", "turn_ids": ["t_5", "t_6", "t_7"]}
```

#### Compact context manually (`:compact`)

```text
H POST /api/v1/sessions/s1:compact
  { "instruction": "Keep database migration conclusions" }
R {}
S {"type": "agent", "event_created_at": "2026-10-29T10:30:00.000Z", "session_id": "s1", "agent_id": "main", "status": "idle", "compacting": true, "plan_mode": false, "swarm_mode": false, "tower_mode": false}
S {"type": "turn.started", "event_created_at": "2026-10-29T10:30:00.000Z", "session_id": "s1", "agent_id": "main", "turn": {"turn_id": "t_8", "ordinal": 5, "turn_number": 5, "kind": "system", "status": "ended", "outcome": "completed", "started_at": "2026-10-29T10:38:00.000Z", "ended_at": "2026-10-29T10:38:00.000Z", "steps": []}}
S {"type": "item.ended", "event_created_at": "2026-10-29T10:30:00.000Z", "session_id": "s1", "agent_id": "main", "turn_id": "t_8", "item": {"item_id": "sys_1", "type": "system", "status": "ended", "outcome": "completed", "created_at": "2026-10-29T10:38:00.000Z", "kind": "compaction", "trigger": "manual", "instruction": "Keep database migration conclusions", "tokens_before": 182340, "tokens_after": 8120, "summary": "…"}}
S {"type": "turn.ended", "event_created_at": "2026-10-29T10:30:00.000Z", "session_id": "s1", "agent_id": "main", "turn": {"turn_id": "t_8", "ordinal": 5, "turn_number": 5, "kind": "system", "status": "ended", "outcome": "completed", "started_at": "2026-10-29T10:38:00.000Z", "ended_at": "2026-10-29T10:38:00.000Z", "steps": []}}
S {"type": "agent", "event_created_at": "2026-10-29T10:30:00.000Z", "session_id": "s1", "agent_id": "main", "status": "idle", "compacting": false, "plan_mode": false, "swarm_mode": false, "tower_mode": false}
```

#### Start a read-only side chat (`:btw`)

```text
H POST /api/v1/sessions/s1:btw
R { "agent_id": "btw_1" }
C { "type": "subscribe", "request_id": "sub-btw", "session_id": "s1", "agent_ids": ["btw_1"] }
S {"type": "response", "request_id": "sub-btw", "code": 0}
```



### Stopping a turn

- [`POST /api/v1/sessions/{session_id}:cancel`](#post-api-v1-sessions-session-id-cancel) cancels the target agent's running turn (defaults to `main`, or pass `agent_id` for a subagent or side conversation); passing `include_background: true` also stops detached background tasks. Returns `{ cancelled: true }` when a turn or background task was cancelled, or `{ cancelled: false }` idempotently when idle. In-flight `tool_call` items end with `outcome: "interrupted"` and keep partial output; pending interactions end with `cancelled`.
- Cancelling a turn does not clear queued user prompts. To stop everything, first withdraw queued prompts with [`POST .../prompts/{prompt_id}:abort`](#post-api-v1-sessions-session-id-prompts-prompt-id-abort), then call `:cancel`.

### Undo

- [`POST /api/v1/sessions/{session_id}:undo`](#post-api-v1-sessions-session-id-undo) takes `{ turn_id, agent_id? }` and removes that turn and all later turns without rolling back disk files.
- The target turn must have `kind: "agent"` and open with a `user_message` whose `origin.kind` is `user`, `skill`, or `plugin_command`; it cannot cross a prior compaction (`40911`), and returns `40901` while the agent is busy.

### Compaction

- [`POST /api/v1/sessions/{session_id}:compact`](#post-api-v1-sessions-session-id-compact) starts manual compaction when `main` is idle (returns `40910` when busy or already compacting).
- During compaction `agent.compacting` is `true`; completion emits a `system` turn carrying a `compaction` item; cancellation emits a `notice` frame with `code: "compaction.cancelled"`.

## Approvals and questions

When a tool call requires permission (`approval`) or asks the user a structured question (`question`), the server pushes an `interaction` frame to every subscriber of the session. Clients reply via [`POST /api/v1/sessions/{session_id}/interactions/{interaction_id}`](#post-api-v1-sessions-session-id-interactions-interaction-id):


#### Receive an approval request and approve for the session

```text
S {"type": "item.updated", "event_created_at": "2026-10-29T10:30:00.000Z", "session_id": "s1", "agent_id": "main", "turn_id": "t_3", "item_id": "c7", "set": {"stage": "awaiting_approval", "interaction_id": "i9"}}
S {"type": "interaction", "event_created_at": "2026-10-29T10:30:00.000Z", "session_id": "s1", "agent_id": "main", "interaction_id": "i9", "kind": "approval", "status": "pending", "tool_call_id": "c7", "request": {"tool_name": "Bash", "action": "Run command", "tool_input_display": {"command": "rm -rf dist"}, "expires_at": "2026-10-30T10:31:00.000Z"}}
H POST /api/v1/sessions/s1/interactions/i9
  { "kind": "approval", "decision": "approved", "scope": "session" }
R { "outcome": "approved", "ended_at": "2026-10-29T10:31:00.000Z" }
S {"type": "interaction", "event_created_at": "2026-10-29T10:30:00.000Z", "session_id": "s1", "agent_id": "main", "interaction_id": "i9", "kind": "approval", "status": "ended", "outcome": "approved", "ended_at": "2026-10-29T10:31:00.000Z", "response": {"decision": "approved", "scope": "session"}, "request": {"tool_name": "Bash", "action": "Run command", "tool_input_display": {"command": "rm -rf dist"}, "expires_at": "2026-10-30T10:31:00.000Z"}}
S {"type": "item.updated", "event_created_at": "2026-10-29T10:30:00.000Z", "session_id": "s1", "agent_id": "main", "turn_id": "t_3", "item_id": "c7", "set": {"stage": "executing"}}
```

#### Receive a question and submit an answer

```text
S {"type": "interaction", "event_created_at": "2026-10-29T10:30:00.000Z", "session_id": "s1", "agent_id": "main", "interaction_id": "i10", "kind": "question", "status": "pending", "tool_call_id": "c8", "request": {"questions": [{"id": "q1", "question": "Which package manager?", "multi_select": false, "allow_other": true, "options": [{"id": "a", "label": "pnpm (Recommended)"}, {"id": "b", "label": "npm"}]}]}}
H POST /api/v1/sessions/s1/interactions/i10
  { "kind": "question", "answers": { "q1": { "kind": "single", "option_id": "a" } }, "method": "click" }
R { "outcome": "answered", "ended_at": "2026-10-29T10:31:20.000Z" }
S {"type": "interaction", "event_created_at": "2026-10-29T10:30:00.000Z", "session_id": "s1", "agent_id": "main", "interaction_id": "i10", "kind": "question", "status": "ended", "outcome": "answered", "ended_at": "2026-10-29T10:31:20.000Z", "request": {"questions": [{"id": "q1", "question": "Which package manager?", "multi_select": false, "allow_other": true, "options": [{"id": "a", "label": "pnpm (Recommended)"}, {"id": "b", "label": "npm"}]}]}, "response": {"answers": {"q1": "pnpm (Recommended)"}, "method": "click"}}
```



| Field | Description |
| --- | --- |
| `interaction_id` | Unique interaction ID used in the reply endpoint URL |
| `kind` | `approval` or `question` |
| `status` | `pending` or `ended` |
| `agent_id`, `tool_call_id` | Originating agent and waiting `tool_call` item ID |
| `request` | Approval: `{ tool_name, action, tool_input_display?, expires_at }`; Question: `{ questions: [{ id, question, header?, body?, options: [{ id, label, description? }], multi_select?, allow_other?, other_label?, other_description? }] }` |
| `outcome`, `ended_at`, `response?` | Present when `status: "ended"`: `outcome` is `approved` / `rejected` / `cancelled` / `answered` / `dismissed` |

Client rules:

- **Close the card on the `status: "ended"` `interaction` frame**, not on the HTTP reply, so all open windows stay in sync.
- **Concurrent replies**: The first reply wins; later replies receive `40902` (already ended) or `40404` (evicted after 60 seconds / 256 entries). Treat both codes as resolved and close the card silently.

## Tasks

Shell commands (foreground and background) and subagents (including AgentSwarm members) are synchronized and controlled exclusively over WebSocket:


#### Start a background command and watch its output (`task.watch`)

```text
S {"type": "task", "event_created_at": "2026-10-29T10:30:00.000Z", "session_id": "s1", "agent_id": "main", "task_id": "bash-k3f9x2ab", "kind": "shell", "status": "running", "detached": true, "description": "Start dev server", "command": "pnpm dev", "parent_tool_call_id": "call_bash_1", "started_at": "2026-10-29T10:33:20.100Z"}
C { "type": "task.watch", "request_id": "r2", "session_id": "s1", "agent_id": "main", "task_id": "bash-k3f9x2ab" }
S {"type": "response", "request_id": "r2", "code": 0, "task": {"task_id": "bash-k3f9x2ab", "kind": "shell", "status": "running", "detached": true}}
S {"type": "task.output", "session_id": "s1", "agent_id": "main", "task_id": "bash-k3f9x2ab", "offset": 0, "text": "> dev\n> vite\n\n"}
S {"type": "task.output", "session_id": "s1", "agent_id": "main", "task_id": "bash-k3f9x2ab", "offset": 14, "text": "  VITE ready in 312 ms\n"}
```

#### Unwatch, resume from `since_offset`, and stop the task (`task.stop`)

```text
C { "type": "task.unwatch", "request_id": "r3", "session_id": "s1", "agent_id": "main", "task_id": "bash-k3f9x2ab" }
S {"type": "response", "request_id": "r3", "code": 0}
... Reopen the output panel and pass the UTF-8 byte end offset 37
C { "type": "task.watch", "request_id": "r4", "session_id": "s1", "agent_id": "main", "task_id": "bash-k3f9x2ab", "since_offset": 37 }
S {"type": "response", "request_id": "r4", "code": 0, "task": {"task_id": "bash-k3f9x2ab", "kind": "shell", "status": "running", "detached": true}}
S {"type": "task.output", "session_id": "s1", "agent_id": "main", "task_id": "bash-k3f9x2ab", "offset": 37, "text": "10:41:07 [vite] hmr update\n"}
C { "type": "task.stop", "request_id": "r5", "session_id": "s1", "agent_id": "main", "task_id": "bash-k3f9x2ab" }
S {"type": "task", "event_created_at": "2026-10-29T10:30:00.000Z", "session_id": "s1", "agent_id": "main", "task_id": "bash-k3f9x2ab", "kind": "shell", "status": "ended", "outcome": "killed", "detached": true, "started_at": "2026-10-29T10:33:20.100Z", "ended_at": "2026-10-29T10:52:03.410Z"}
S {"type": "response", "request_id": "r5", "code": 0, "task": {"task_id": "bash-k3f9x2ab", "kind": "shell", "status": "ended", "outcome": "killed", "detached": true}}
```



### Task list

`task.list` is the complete running-task snapshot for `(session_id, agent_id)` — replace the local running list on receipt. Each incremental `task` frame replaces or inserts the entry keyed by `task_id`.

| Field | Description |
| --- | --- |
| `task_id` | Task ID |
| `kind` | `shell` / `subagent` / `other` |
| `status` | `running` or `ended` (an ended task emits one final `task` frame and is absent from future `task.list` frames) |
| `outcome` | On ended tasks: `completed` / `failed` / `timed_out` / `killed` / `lost` |
| `phase` | On running subagents: `working` or `suspended` |
| `state_reason` | On suspended subagents: human-readable suspension reason |
| `detached` | `false` while the spawning tool call is still awaiting it (foreground); `true` when running in the background |
| `description`, `command` | Description and shell command string |
| `child_agent_id`, `parent_tool_call_id`, `swarm_index` | Subagent ID, spawning tool call ID, and swarm member index |
| `model`, `thinking` | Subagent model and thinking level |
| `started_at`, `ended_at`, `result_summary`, `error` | Timestamps, summary, and error |

### Task output and control

- **`task.watch` and byte-offset merging**: The server replies with `response` (carrying the current `task` state) followed by an initial `task.output` chunk (up to the last 32 KiB by default, max 1 MiB, or bytes after `since_offset` when within the tail window). Track the absolute stream end offset (`chunk.offset + UTF-8 byte length of chunk.text`): if the initial chunk's `offset` equals your tracked end offset, append `text` and advance the end offset; otherwise replace your local buffer with `chunk.text` starting at `chunk.offset`.
- **Stopping or backgrounding a foreground tool**: Foreground tasks appear in `task.list` with `detached: false` and `parent_tool_call_id`. Sending `task.stop` stops only that tool call while the turn continues; sending `task.background` detaches it (`detached: true`, the tool call completes immediately, and a `notification` item arrives when the background task finishes; AgentSwarm members cannot be detached and return `40933`).
- **Task command errors**: Malformed `task.*` frames return `40001`; `task.watch`, `task.stop`, and `task.background` return `40401` when the session does not exist, `40406` when the agent or task does not exist, and `50001` on internal failure. In addition, `task.watch` returns `50003` when persisted task output cannot be read, and `task.background` returns `40933` when the task cannot be detached (`task.unwatch` succeeds idempotently with `0` once validated).

## Agent state

Each agent's state is split into four independent full-replacement frames by update cadence:

| Frame | Core fields | Description |
| --- | --- | --- |
| `agent` | `status: "idle" \| "running" \| "ended"`, `compacting`, `model?`, `thinking?`, `permission_mode?`, `plan_mode`, `swarm_mode`, `tower_mode` | Running status and active settings. Update settings via [`POST /api/v1/sessions/{session_id}/profile`](#post-api-v1-sessions-session-id-profile) |
| `context` | `context_tokens`, `max_context_tokens?` | Context window water-level for this agent alone, **coalesced over a 250 ms window** |
| `goal` | `goal?: { objective, status, completion_criterion?, turns_used, tokens_used, wall_clock_ms }` | Main agent only (`goal` is omitted when no goal is active; increment `wall_clock_ms` locally for live timers) |
| `todo` | `items: [{ title, status: "pending" \| "in_progress" \| "done" }]` | Agent todo list, replaced as a whole on writes and `:undo` |

## Reconnecting

Subscriptions and `task.watch` streams do not persist across disconnects. After reconnecting:

1. **Resend `subscribe`**: When the `response` succeeds, clear local turns and in-flight pagination requests for that session, and rebuild state from the incoming `interaction`, `task.list`, state frames, and `turns`.
2. **Re-watch task output**: Resend `task.watch` for any open output panel with `since_offset` set to your tracked absolute end offset (`initial_offset + UTF-8 byte length of buffered text`).
3. **Refresh global lists**: Global events missed while offline are not replayed; re-fetch [`GET /api/v1/sessions`](#get-api-v1-sessions) and other global lists via REST.

## Global events

Global events are sent to every connected WebSocket client without subscription. Every frame is flat and starts with `type` and `event_created_at`; there is no `session_id`, `timestamp`, or `payload` envelope:

```text
S {"type": "session", "event_created_at": "2026-10-29T10:41:30.000Z", "change": "updated", "session": {"id": "s2", "workspace_id": "wd_aaa_000000000000", "cwd": "/work/app", "title": "Fix login", "created_at": "2026-10-29T10:30:00.000Z", "updated_at": "2026-10-29T10:41:30.000Z", "activity": "idle", "pending_interaction": "none", "last_turn_outcome": "completed", "archived": false}}
S {"type": "invalidated", "event_created_at": "2026-10-29T10:42:00.000Z", "kind": "models"}
```

| `type` | Additional fields | Client rule |
| --- | --- | --- |
| `session` | `change`: `created` / `updated` / `archived` / `restored` / `deleted`; `session` is the full [session object](#session-object) | Replace by `session.id`; delete when `change` is `deleted`. Creation, renames, archive/restore, activity, and latest-turn outcomes all use this frame |
| `workspace` | `change`: `created` / `updated` / `deleted`; `workspace` is the full [workspace object](#workspace-object) | Replace by `workspace.id`; delete when `change` is `deleted` |
| `config` | `config` is the full configuration with secrets redacted; optional `warnings` is `{ domain?, message }[]` | Replace local config and surface any warnings |
| `invalidated` | `kind`: `models` / `plugins` | The list changed but its contents are not included: refetch `GET /api/v1/models` for `models`, or `GET /api/v1/plugins` for `plugins` |

Built-in capability installation progress uses a separate flat `event.capability.changed` frame with `event_created_at`, `capability_id`, and `install`. It is not an invalidation notice; clients should keep showing installation progress.

Global frames reflect changes originating in this server process only. When another Kimi Code process or CLI shares the same home directory, the server's session index reconciles external disk changes periodically (~60 s) without emitting WebSocket broadcasts; overview dashboards should keep a low-frequency fallback poll of `GET /api/v1/sessions` (e.g., every 60 s or on window focus).

---

# Session endpoints

This section lists the REST endpoints under `/api/v1/sessions` (session file system endpoints are in [File endpoints](#file-endpoints)). For the WebSocket side (conversation frames, [subscribing to a session](#subscribing-to-a-session), and how a client drives a turn), see [Sessions and conversations](#sessions-and-conversations). For shared conventions such as the response envelope, authentication, error codes, and pagination, see [Overview](#kimi-agent-protocol-kap-reference-beta).

## Sessions

These endpoints manage sessions themselves: create, list, read, and update sessions, run session actions such as fork, compact, and undo, and read session-level information such as the goal, warnings, environments, and file history. Every endpoint that returns a session uses the [session object](#session-object) shape.

### Session object

Every endpoint that returns a session uses this shape. The object contains only what session lists and background views need to display. Model, permission mode, and run mode live in each agent's [`agent` frame](#agent-state), context water-level in its `context` frame, and the current goal in its `goal` frame.

| Field | Type | Description |
| --- | --- | --- |
| `id` | string | Session id (`session_...`) |
| `workspace_id` | string | Owning workspace id |
| `cwd` | string | Session working directory |
| `title` | string | Session title; `""` when untitled |
| `created_at` / `updated_at` | string | Creation and last-update times, ISO 8601 |
| `archived` | boolean | Whether the session is archived. Archived sessions do not appear in the default session list |
| `archived_at` | string | Archive time, ISO 8601. Present only when archived |
| `activity` | string | Current activity state: `idle` / `turn` (main agent has an active turn) / `background` (main agent has no active turn, but subagents, background tasks, or compaction are running) |
| `pending_interaction` | string | The interaction waiting for an answer: `none` / `approval` / `question`. `approval` when an approval and a question are both pending |
| `last_turn_outcome` | string | Outcome of the main agent's latest turn: `completed` / `interrupted` / `failed` (matches `Turn.outcome`); omitted when no turn has ended |
| `last_prompt` | string | Text of the most recent user prompt, when present |
| `metadata` | object | Optional custom metadata, stored as supplied except for reserved keys (`cwd`, `goal`, `parent_session_id`, and `child_session_kind`—`cwd` is exposed via top-level `cwd`, and the others are server-managed) |
| `git` | object | Present only when `GET /api/v1/sessions` is called with `include=git`. Carries optional `branch` (current branch; omitted for detached HEAD or non-Git directories) and optional `pull_request` (`{ number, state: "open" \| "closed" \| "merged", url }`; omitted when none) |

### Create, read, and update sessions

Create sessions, list and read them, archive or restore sessions in batch, and update a session's title, metadata, and main agent config.

| Method and path | Description |
| --- | --- |
| `POST /api/v1/sessions` | Create a session (requires `workspace_id` or `cwd`) |
| `GET /api/v1/sessions` | List sessions with filtering, sorting, workspace grouping, `include=git`, and pagination |
| `POST /api/v1/sessions:archive` | Archive sessions in batch |
| `POST /api/v1/sessions:restore` | Restore archived sessions in batch |
| `GET /api/v1/sessions/{session_id}` | Read one session |
| `POST /api/v1/sessions/{session_id}/profile` | Update the title, metadata, and main agent config |
| `POST /api/v1/sessions/{session_id}/title/generate` | Generate a title through the managed `chat_title` tool |

#### `POST /api/v1/sessions`

Creates a session and returns it. On success, the server broadcasts the global `session` with `change: "created"` event (see [Global events](#global-events)).

The session's directory comes from `workspace_id` (a registered workspace) or `cwd` / `metadata.cwd` (the workspace is registered on first use). When both are given, they must agree.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `workspace_id` | body | string | Required when `cwd` is absent. A registered workspace id; the session is created at that workspace's root |
| `cwd` | body | string | Working directory of the session; required when `workspace_id` is absent. With `workspace_id` also given, it must equal the workspace root |
| `metadata` | body | object | Custom metadata. The working directory may also be passed as `metadata.cwd`; other keys are kept as custom metadata, and the reserved keys `goal`, `parent_session_id`, and `child_session_kind` are dropped |
| `title` | body | string | Initial title, at least 1 character. Without it, the session is untitled |
| `agent_config` | body | object | Partial main agent config, applied before the session is returned. Same fields as `agent_config` in [`POST /api/v1/sessions/{session_id}/profile`](#post-api-v1-sessions-session-id-profile), plus `profile` |
| `environment_id` | body | string | Id of the environment the main agent runs in; `local` means this machine. Without it, the server uses `default` under `[environments]` in `config.toml`, or this machine when that is not configured. A non-local environment must be declared under `[environments]` or already registered. With a value other than `local`, the server creates the main agent before returning the session |
| `environment_cwd` | body | string | Working directory on the environment. Requires `environment_id`. For a non-local environment without this field, the environment's `defaultCwd` under `[environments]` is used |

The main agent is bound when the session is created:

- `agent_config.profile` picks the agent profile, default `agent`. The agent profile cannot change afterwards.
- `agent_config.model` picks the model, default the server's current default model. Later changes to the default model do not affect the session.
- `agent_config.thinking` is checked against that model in the same bind.

When `agent_config` cannot be applied, the server does not create the session and returns the error. When `agent_config` sets `tower_mode: true`, the request fails with `40001`: entering Tower mode changes the repository and cannot be undone if creation fails, so enable it through `POST /api/v1/sessions/{session_id}/profile` after the session exists.

When no model is available (no default model is configured, or the default model cannot be resolved), the session is still created, but without a model. In that case, if `agent_config` sets `profile` or `thinking`, the server does not create the session.

On success, `data` is the [session object](#session-object) of the new session.

- `40001`: neither `workspace_id` nor `metadata.cwd` is given; `metadata.cwd` does not match the workspace root; `agent_config` sets `tower_mode: true` (`details` lists the field); `agent_config.model` is not configured; `agent_config.profile` is an unknown agent profile; the model does not support `agent_config.thinking`; `environment_cwd` is given without `environment_id`; a non-local environment is not declared, fails to register, or has no usable working directory
- `40113`: no model is available while `agent_config` sets `profile` or `thinking`
- `40409`: the working directory does not exist or is not a directory. With a non-local environment, the server does not check whether the working directory exists
- `40410`: no workspace is registered with that `workspace_id`
- `40420`: the environment does not exist
- `40913`–`40918`, `40920`: `agent_config` could not be applied because of a goal error
- `40926`: the environment is unavailable

#### `GET /api/v1/sessions`

Queries sessions across workspaces with filtering, sorting, workspace grouping, optional Git metadata, and lightweight id projection. Paginate with an opaque `page_token`, a 1-based `page` number, or `before_id` / `after_id` cursors in the flat view (all four are mutually exclusive; see [Pagination](#pagination)).

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `workspace_id` | query | string | Filter by workspace; repeatable, accepts workspace aliases. Unknown workspaces return an empty list |
| `archived` | query | string | `false` (default, unarchived only) / `true` (archived only) / `all` |
| `has_prompt` | query | boolean | `true` keeps only sessions with a user prompt; `false` keeps only empty sessions |
| `busy` | query | boolean | Keep only busy (or only idle) sessions |
| `activity` | query | string | Filter by activity: `idle` / `turn` (main agent has an active turn) / `background` (only background work or compaction is active); repeatable |
| `updated_after` | query | string | Only sessions updated at or after this time (ISO 8601) |
| `updated_before` | query | string | Only sessions updated at or before this time (ISO 8601) |
| `sort` | query | string | `updated_at_desc` (default) / `updated_at_asc` / `created_at_desc` |
| `view` | query | string | `flat` (default) / `by_workspace` |
| `group_page_size` | query | integer | Sessions returned per workspace under `view=by_workspace`: 1–100, default `5` (up to `10000` with the `id,archived` projection) |
| `include` | query | string | Comma-separated extra field groups. Currently supports `git` (branch and PR info, deduplicated per environment and working directory and cached for 60 seconds) |
| `fields` | query | string | Comma-separated field projection. Currently supports only `id,archived`, trimming each item to `{ id, archived }` (for select-all-matching flows) |
| `page_size` | query | integer | 1–100, default `50`; up to `10000` with the `id,archived` projection. Under `view=by_workspace` it counts groups |
| `page_token` | query | string | Pagination token returned by the previous page |
| `page` | query | integer | Stateless page number, starting at 1 |
| `before_id` | query | string | In the flat view, only sessions ordered after this session |
| `after_id` | query | string | In the flat view, only sessions ordered before this session |

In the flat view, `data` is `{ items, total, has_more, next_page_token? }`: each item is a [session object](#session-object) by default (with `git` attached when `include=git` is passed), or `{ id, archived }` when `fields=id,archived` is passed. `total` is the size of the filtered set. `next_page_token` is present only when paging with `page_token` (or default pagination) and `has_more` is `true`; changing any query condition mid-pagination returns `40922`. `page`, `before_id`, and `after_id` modes do not mint tokens.

With `view=by_workspace`, the filtered and sorted set is grouped by canonical workspace id, and `data` is `{ groups, total, has_more, next_page_token? }`:

| Field | Type | Description |
| --- | --- | --- |
| `groups[].workspace_id` | string | Workspace id the group belongs to |
| `groups[].sessions` | array | The workspace's first `group_page_size` sessions, ordered by the requested `sort` |
| `groups[].total` | integer | Total number of the workspace's sessions that match the filters |
| `total` | integer | Number of groups in the grouped view |

Only workspaces with at least one matching session appear. Groups are ordered by the sort key of their first session, with ties broken by `workspace_id`. `page` and `page_token` paginate over groups.

- `40001`: validation failure, such as passing more than one pagination cursor parameter, combining `before_id` / `after_id` with `view=by_workspace`, passing `group_page_size` without `view=by_workspace`, or combining `fields=id,archived` with `include=git`
- `40922`: during pagination, the query conditions (including projection, `view`, and grouping parameters) do not match `page_token`

#### `POST /api/v1/sessions:archive`

Archives sessions in batch, for session management views. Sessions that are still live go through the full lifecycle; cold sessions that are not loaded have their on-disk metadata rewritten directly and are not loaded.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `ids` | body | array | Required. Array of session ids; must not be empty, at most 5000 after deduplication |

Only a body validation failure fails the whole request. Other errors are returned per item:

| Field | Type | Description |
| --- | --- | --- |
| `results` | array | Result for each id, in input order. A success is `{ id, ok }`; a failure is `{ id, ok: false, error }`. An id that does not exist reports `40401` in its own entry |
| `succeeded` | integer | Number of successes |
| `failed` | integer | Number of failures |

- `40001`: request body validation failure

#### `POST /api/v1/sessions:restore`

Restores archived sessions in batch. The request body, the handling of live and cold sessions, the per-item results, and the error codes are the same as [`POST /api/v1/sessions:archive`](#post-api-v1-sessions-archive).

#### `GET /api/v1/sessions/{session_id}`

Reads one session from the index. When the session is loaded in this process, the live status fields are included; a cold session reports not busy and carries its last persisted turn outcome.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `session_id` | path | string | Required. Session id |

On success, `data` is a [session object](#session-object).

- `40401`: the session does not exist, or its workspace can no longer be resolved

#### `POST /api/v1/sessions/{session_id}/profile`

Updates the session profile: the title, custom metadata, and the main agent's config.

A title set here is a custom title and takes precedence over generated titles. Setting a title broadcasts the global `session` with `change: "updated"` event.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `session_id` | path | string | Required. Session id |
| `title` | body | string | New title, at least 1 character. Becomes a custom title |
| `metadata` | body | object | When non-empty, replaces the session's custom metadata as a whole. The reserved keys `cwd`, `goal`, `parent_session_id`, and `child_session_kind` are ignored, and the values the session already stores for them are kept |
| `agent_config` | body | object | Partial main agent config; fields in the table below |

All `agent_config` fields are optional. The server applies them to the main agent one by one in this order: `model`, `thinking`, `permission_mode`, `plan_mode`, `swarm_mode`, `tower_mode`, `goal_objective`, `goal_control`. Applying is not atomic: when a field fails, the fields before it have already taken effect and are not rolled back. Except for `goal_objective` and `goal_control`, sending a field again has no extra effect, so these fields are safe to resend.

| Field | Type | Description |
| --- | --- | --- |
| `model` | string | Model alias id. An empty string is ignored |
| `thinking` | string | Thinking effort level |
| `permission_mode` | string | `manual` / `yolo` / `auto`. Synced to every agent in the session, except agents with a fixed permission mode (for example Tower workers) |
| `plan_mode` | boolean | Enter or exit Plan mode |
| `swarm_mode` | boolean | Enter or exit swarm mode |
| `tower_mode` | boolean | Enter or exit Tower mode. Requires the Tower experimental flag (`KIMI_CODE_EXPERIMENTAL_TOWER=1`, or `[experimental] tower = true` in `config.toml`) |
| `tower_base` | string | Base branch used when entering Tower mode; used only together with `tower_mode: true`. When the branch does not exist, the server creates it in the repository, switches to it, and commits uncommitted changes onto it |
| `goal_objective` | string | Create a goal with this text |
| `goal_control` | string | Control the current goal: `pause` / `resume` / `cancel` / `edit`; `edit` requires `goal_objective` |

On success, `data` is `{ session, agent }`: `session` is the updated [session object](#session-object), and `agent` is the main agent's current state with `status`, `compacting`, `model`, `thinking`, `permission_mode`, `plan_mode`, `swarm_mode`, and `tower_mode`, using the same fields as the [`agent` frame](#agent-state).

- `40001`: `model` is not configured; the model does not support `thinking`; `agent_config.profile` is given (the agent profile can only be chosen when the session is created)
- `40113`: the session has no model, and the request sets only `thinking` without `model`
- `40401`: the session does not exist
- `40913`–`40918`, `40920`: `goal_objective` or `goal_control` could not be applied because of a goal error, for example a goal already exists, there is no goal, or the goal's status does not allow the operation
- `40935`: Tower mode cannot be entered: the experimental flag is off; the Tower feature is not wired into this server process and a restart is needed; or the workspace's Tower is held by another session that is running or waiting for an answer

#### `POST /api/v1/sessions/{session_id}/title/generate`

Generates a title from the session's prompts, applies it to the session, and broadcasts `session` with `change: "updated"`. The title is generated by the managed provider's `chat_title` tool.

Title generation requires the managed OAuth login. Without `force`, a session that already has a custom or generated title is reported unavailable, and its existing title is not overwritten.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `session_id` | path | string | Required. Session id |
| `force` | body | boolean | Regenerate even when a custom or generated title exists. Default `false` |
| `source` | body | string | Input used to generate the title: `user_prompts` (default) / `first_turn` / `digest` |

On success, `data` is `{ title }`, the title now applied to the session.

- `40401`: the session does not exist
- `40923`: the title cannot be generated: the flag is off; there is no managed OAuth login; the session has no prompt content yet; a title exists and `force` is not set; the backend request failed

### Session actions

Session actions are non-CRUD operations on one session. Following the `:{action}` convention, they are POSTed to `/api/v1/sessions/{session_id}:{action}`.

| Method and path | Description |
| --- | --- |
| `POST /api/v1/sessions/{session_id}:fork` | Copy the session into a new session in the same workspace |
| `POST /api/v1/sessions/{session_id}:compact` | Manually compact the main agent's context |
| `POST /api/v1/sessions/{session_id}:undo` | Undo a turn and the turns after it |
| `POST /api/v1/sessions/{session_id}:cancel` | Cancel a target agent's running turn (defaults to main agent) and optional background tasks |
| `POST /api/v1/sessions/{session_id}:btw` | Start a read-only side conversation |
| `POST /api/v1/sessions/{session_id}:archive` | Archive the session |
| `POST /api/v1/sessions/{session_id}:restore` | Unarchive the session |
| `POST /api/v1/sessions/{session_id}:delete` | Permanently delete the session |
| `POST /api/v1/sessions/{session_id}:reload` | Reload the session with the latest on-disk configuration |
| `POST /api/v1/sessions/{session_id}:takeover` | Remove a session lock left behind by another process |

#### `POST /api/v1/sessions/{session_id}:{action}`

All session actions go through one route: the end of the path is parsed as `{session_id}:{action}`, and the request body is validated against that action's schema. The parameter tables of the actions below list only body fields.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `session_id` | path | string | Required. Session id |
| `action` | path | string | Required. Action name; values in the table above |

- `40001`: the action is missing or unknown (`unsupported action: ...`)
- `40401`: the session does not exist. Every action resolves the session first, so every action can return this code

#### `POST /api/v1/sessions/{session_id}:fork`

Copies the session, including its conversation, agent state, and files, into a new session in the same workspace, and broadcasts `session` with `change: "created"`. The source session keeps running.

When the source session has an active turn, the fork keeps the most recent completed boundary before that turn and saves the current turn's user prompt as a prompt-only `cancelled` turn. That turn contains no assistant output, tool activity, queued input, or later events.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `title` | body | string | Title for the fork, at least 1 character. Default `Fork: <source title>` |
| `metadata` | body | object | Custom metadata for the fork |
| `turn_index` | body | integer | The turn to keep up to, inclusive, as the persisted engine `turnId`; gaps in the numbering are allowed. Must be a non-negative safe integer, and the turn must be complete |

On success, `data` is the [session object](#session-object) of the new session.

- `40001`: `turn_index` is invalid, does not exist, or points to the active turn
- `40901`: another session history operation is in progress

#### `POST /api/v1/sessions/{session_id}:compact`

Starts a manual full compaction of the main agent's context. The call returns immediately without waiting for the compaction to finish.

During compaction, `compacting` is `true` in the WebSocket [`agent` frame](#agent-state). When compaction finishes, the result appears in the conversation as a [`system`](#system) item. When compaction is cancelled, nothing is left in the conversation, and subscribers receive a [`notice` frame](#live-updates) with `code` `compaction.cancelled`.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `instruction` | body | string | Extra guidance for the compaction summary. A blank value is ignored |

Compaction is not queued. It can start only when the main agent is idle; see [Compaction](#compaction) for the flow.

On success, `data` is `{}`.

- `40910`: a compaction is already in progress; a turn is running; prompts are pending in the queue; another context change or session history operation (for example undo or fork) is in progress; the history has nothing to compact

#### `POST /api/v1/sessions/{session_id}:undo`

Undoes a turn and every turn after it in an agent's conversation, including the system turns and the turns triggered by scheduled tasks and the like in between. The server also reconciles the derived session state (including the session's `last_prompt`). Files are not rolled back. See [Undo](#undo) for the flow.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `turn_id` | body | string | Required. The turn to undo. It must be an `agent` turn whose opening `user_message` comes from the user, a skill the user invoked with a slash command, or a plugin command |
| `agent_id` | body | string | The agent whose conversation to undo. Default `main` |

On success, `data` is `{ removed_turn_ids }`: the removed turns in ascending ordinal order, starting with `turn_id`. Subscribers receive a [`turns.removed` frame](#live-updates) with the same `turn_ids`. The response and the frame can arrive in either order.

- `40421`: the turn does not exist
- `40901`: the agent is working (a running turn, queued input, or a context compaction in progress); retry after it finishes
- `40911`: the turn cannot be undone: it does not open with user input (`data` is `null`), or the removed range crosses a context compaction / lacks enough undo anchors (`data` is `{ reason: "compaction_boundary" | "empty" | "insufficient", requestedCount, undoableCount }`)
- `40932`: another client updated the session. The server has reloaded the session, and nothing was undone this time (see [Error codes](#error-codes))

#### `POST /api/v1/sessions/{session_id}:cancel`

Cancels the target agent's current turn (defaults to `main`); when `include_background: true` is passed, also stops detached background tasks.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `agent_id` | body | string | Optional. Target agent id; defaults to `main` (supports subagents and side-conversation agents) |
| `include_background` | body | boolean | Optional. When `true`, also terminates detached background tasks (across all agents in the session when `agent_id` is omitted, or only `agent_id` when specified). Default `false` |

On success, `data` is `{ cancelled }`: `true` when a running turn or background task was cancelled, or `{ cancelled: false }` idempotently when idle or when the session is cold (calling on `main` does not wake a cold session). To confirm the turn has stopped, wait for that turn's `turn.ended` frame.

Cancelling a turn does not clear the queue: queued user prompts and user steering messages not yet inserted are kept and start after the stopped turn ends; queued skill activations are cancelled. See [Stopping a turn](#stopping-a-turn) for the flow.

- `40401`: the session or specified `agent_id` does not exist

#### `POST /api/v1/sessions/{session_id}:btw`

Starts a "by the way" side conversation: forks the main agent into a subagent that can use only the read-only tools `Read`, `Grep`, and `Glob`, so quick side questions run in isolation without touching the working context. Requires a usable model configuration.

On success, `data` is `{ agent_id }`, the id of the new subagent.

To stop a running turn of a side conversation, call [`POST /api/v1/sessions/{session_id}:cancel`](#post-api-v1-sessions-session-id-cancel) with `{ "agent_id": "<btw_agent_id>" }`.

#### `POST /api/v1/sessions/{session_id}:archive`

Marks the session archived and broadcasts the global `session` with `change: "archived"` event. An archived session does not appear in the default session list; it is still listed with `archived=true` or `archived=all`.

On success, `data` is `{ archived: true }`.

#### `POST /api/v1/sessions/{session_id}:restore`

Unarchives the session. When the session was archived, the server broadcasts the global `session` with `change: "restored"` event.

On success, `data` is the [session object](#session-object), with `archived` set to `false`.

#### `POST /api/v1/sessions/{session_id}:delete`

Permanently deletes the session. When the session is loaded in this process, it is closed first. The server then deletes its on-disk data, index entry, and file history, and broadcasts the global `session` with `change: "deleted"` event (see [Global events](#global-events)). Deletion cannot be undone.

On success, `data` is `{ deleted: true }`.

#### `POST /api/v1/sessions/{session_id}:reload`

Reloads the session with the latest on-disk configuration: re-reads `config.toml` and plugins, reloads the workspace's skill and subagent catalogs, then closes the session and resumes it from disk. The server also notifies the main agent of external changes to `AGENTS.md`, skills, subagents, and models through system reminders (system-reminder).

On success, `data` is the [session object](#session-object). Although the session is closed and reopened, existing subscriptions stay valid and the server resends the frames; see [When the server closes and reopens a session](#when-the-server-closes-and-reopens-a-session).

- `40901`: an agent has a running turn or a context compaction in progress, so the session cannot be reloaded

#### `POST /api/v1/sessions/{session_id}:takeover`

Removes the lock another Kimi Code process holds on the session. After that, requests that previously failed with [`40931`](#error-codes) can be retried.

Use it only when the process holding the lock has exited and left the lock behind. If that process is still running, both processes write to the session until it goes idle, and the session history can interleave.

On success, `data` is `{ taken_over: true }`.

- `40401`: the session does not exist

### Goals

The current goal is synchronized through the WebSocket [`goal` frame](#agent-state), including its objective, status, completion criterion, and usage counters (`turns_used`, `tokens_used`, `wall_clock_ms`). Create, pause, resume, cancel, and edit goals through [`POST /api/v1/sessions/{session_id}/profile`](#post-api-v1-sessions-session-id-profile):

- `goal_objective`: creates a goal, or supplies the new objective when `goal_control` is `edit`. An in-place edit preserves the goal id, status, progress, and budget; the agent receives the new text on its next turn.
- `goal_control`: `pause` / `resume` / `cancel` / `edit`. `edit` requires `goal_objective` and can only be used on an existing goal.

### Warnings and environments

Read session-level warnings, the environment the main agent runs in, and the environments available to the session.

| Method and path | Description |
| --- | --- |
| `GET /api/v1/sessions/{session_id}/warnings` | Session-level warnings |
| `GET /api/v1/sessions/{session_id}/environment` | Read the main agent's environment binding |
| `GET /api/v1/sessions/{session_id}/environments` | List the environments registered for the session's workspace |

#### `GET /api/v1/sessions/{session_id}/warnings`

Reads session-level warnings. Currently only the oversized `AGENTS.md` check (`agents-md-oversized`) produces warnings, so the list is empty for most sessions.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `session_id` | path | string | Required. Session id |

On success, `data` is `{ warnings }`:

| Field | Type | Description |
| --- | --- | --- |
| `warnings[].code` | string | Warning code, for example `agents-md-oversized` |
| `warnings[].message` | string | Warning message |
| `warnings[].severity` | string | `info` / `warning` / `error` |

- `40401`: the session does not exist

#### `GET /api/v1/sessions/{session_id}/environment`

Reads the main agent's environment binding, that is, which environment the session's agent loop runs on.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `session_id` | path | string | Required. Session id |

On success, `data` is:

| Field | Type | Description |
| --- | --- | --- |
| `workspace_id` | string | Workspace id |
| `environment_id` | string | Id of the bound environment |
| `cwd` | string | Working directory on the bound environment. Returned only when the binding carries one |

- `40401`: the session does not exist

#### `GET /api/v1/sessions/{session_id}/environments`

Lists the environments available to the session, that is, the environments registered for the session's workspace.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `session_id` | path | string | Required. Session id |

On success, `data` is `{ environments }`:

| Field | Type | Description |
| --- | --- | --- |
| `environments[].environment_id` | string | Environment id |
| `environments[].type` | string | `local` / `ssh` / `docker` / `command` |
| `environments[].status` | string | `pending` / `connecting` / `ready` / `disconnected` / `disposed`. `pending` means there is no live connection and no observed failure (never connected) |
| `environments[].connect_error` | string | Failure reason of a `disconnected` entry |

- `40401`: the session does not exist

### Export and media

These two endpoints return binary streams instead of a JSON envelope. For HTTP behavior such as Range and ETag, see [Binary and streaming endpoints](#binary-and-streaming-endpoints).

| Method and path | Description |
| --- | --- |
| `POST /api/v1/sessions/{session_id}/export` | Export the session with diagnostics (zip stream, not enveloped) |
| `GET /api/v1/sessions/{session_id}/media/{file_id}` | Download prompt media by file id (binary) |

#### `POST /api/v1/sessions/{session_id}/export`

Exports the session together with diagnostic logs as a zip attachment (`kimi-session-<id>.zip`). The response is a binary stream, not a JSON envelope; for the supported HTTP capabilities and failure semantics, see [Binary and streaming endpoints](#binary-and-streaming-endpoints).

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `session_id` | path | string | Required. Session id |
| `web_log` | body | string | Client log text to include in the archive, at most 256 KB UTF-8 |
| `desktop` | body | boolean | Also include the desktop host's logs. Default `false` |

#### `GET /api/v1/sessions/{session_id}/media/{file_id}`

Downloads a prompt media file by file id, that is, an image or other attachment referenced by the session's prompts. When the id is not yet committed to the session, the server falls back to the staged uploads.

The response is binary and supports `Range` (ranged requests return 206); see [Binary and streaming endpoints](#binary-and-streaming-endpoints) for the shared conventions. When the session or file does not exist, the response has a real HTTP 404 status with an envelope body. This differs from the endpoints there that return error envelopes with HTTP 200.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `session_id` | path | string | Required. Session id |
| `file_id` | path | string | Required. Media file id |

### File history

Read the files the main agent changed in a turn and their contents before and after, for example to show a turn's diff.

| Method and path | Description |
| --- | --- |
| `GET /api/v1/sessions/{session_id}/file-history/changes` | List the files one turn changed |
| `GET /api/v1/sessions/{session_id}/file-history/content` | Read a file's content at the start or end of a turn |

#### `GET /api/v1/sessions/{session_id}/file-history/changes`

Lists the files one turn of the main agent changed, from the turn-level file history. The server compares the contents recorded when the turn started with those recorded when it ended; while the turn is still running, it compares with the current files on disk. Unchanged files are not listed.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `session_id` | path | string | Required. Session id |
| `turn_number` | query | integer | Required. The turn's `turn_number` (see [Turns](#turns)) |

On success, `data` is `{ changes, recorded }`:

| Field | Type | Description |
| --- | --- | --- |
| `changes[].path` | string | File path |
| `changes[].status` | string | `added` / `modified` / `deleted` |
| `changes[].additions` / `changes[].deletions` | number | Number of added and deleted lines |
| `changes[].binary` | boolean | The file is not text, or its content is no longer stored. Both line counts are `0` |
| `changes[].oversize` | boolean | The file was too large to record. Both line counts are `0` |
| `recorded` | boolean | `false` when the turn's file history is incomplete (never recorded, or some recorded contents were later cleaned up); `changes` may then be empty or partial |

- `40001`: `turn_number` is missing or invalid
- `40401`: the session does not exist

#### `GET /api/v1/sessions/{session_id}/file-history/content`

Reads a file's content as the main agent's file history recorded it at the start or end of a turn, for example to show the turn's diff.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `session_id` | path | string | Required. Session id |
| `turn_number` | query | integer | Required. The turn's `turn_number` |
| `path` | query | string | Required. File path, as listed by `file-history/changes` |
| `phase` | query | string | `start` (default) for the content before the turn, `end` for the content after it |

On success, `data` is `{ content }`. `content` is `null` when the turn has no record for that phase, or the file was not recorded, was too large, or its stored content no longer exists. Otherwise `content` is:

| Field | Type | Description |
| --- | --- | --- |
| `content.version` | number | The file's version number in the history |
| `content.content` | string | Text content |
| `content.binary` | boolean | `true` when the file is not text |

When neither `content.content` nor `content.binary` is present, the file did not exist at that point. With `phase=end`, a file the turn did not change is returned with its content at the start.

- `40001`: `turn_number` or `path` is missing or invalid
- `40401`: the session does not exist

### Satisfaction survey

After a turn ends, a client may show a satisfaction survey. The client uses the endpoint below to ask whether to show the survey and to report when it was shown and how the user answered.

| Method and path | Description |
| --- | --- |
| `POST /api/v1/sessions/{session_id}/rating` | Ask whether to show the satisfaction survey, and report its display and answer |

#### `POST /api/v1/sessions/{session_id}/rating`

After a turn completes, the client first asks with `evaluate` whether to show the survey, then reports the survey's display and answer. Whether a survey is offered depends on sampling rules set by the Kimi Code service and on local cooldowns, so most evaluations offer no survey.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `session_id` | path | string | Required. Session id |
| `op` | body | string | Required. `evaluate` / `shown` / `respond` / `abandon` |
| `turn_id` | body | string | Required with `evaluate`. The `turn_id` of the turn that just completed |
| `appearance_id` | body | string | Required with `shown` / `respond` / `abandon`. The `id` returned by `evaluate` |
| `response` | body | string | Required with `respond`. `bad` / `fine` / `good` / `dismissed` |

With `evaluate`, `data` is `{ appearance }`. When the client should show a survey now, `appearance` is `{ id, survey }`, with `survey` either `session` or `long_context`; otherwise it is `null`. It is also `null` when the turn is not the main agent's latest completed turn, when `disable_feedback_survey` is on, or when telemetry is off.

Then report what happened to the survey. All three operations return `data: null`:

| `op` | When to report |
| --- | --- |
| `shown` | The survey has been shown |
| `respond` | The user has answered. When the user closes the survey, `response` is `dismissed` |
| `abandon` | The survey went away without an answer, for example because the user moved elsewhere |

- `40001`: validation failure

### Session skills

List the skills available to a session, or activate a skill in a session. Activation is the REST form of the `/<skill>` slash command; as a non-CRUD operation, it also uses the `:{action}` convention. To read a workspace's skill catalog without creating a session, see [`GET /api/v1/workspaces/{workspace_id}/skills`](#get-api-v1-workspaces-workspace-id-skills).

| Method and path | Description |
| --- | --- |
| `GET /api/v1/sessions/{session_id}/skills` | Session-level skill catalog |
| `POST /api/v1/sessions/{session_id}/skills/{skill_name}:activate` | Activate a skill (starts a turn) |

#### `GET /api/v1/sessions/{session_id}/skills`

Lists the skills available to one session, merged from every source (built-in, plugin, extra, user, project) with the session's precedence applied. Reading the catalog resumes the session when it is cold.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `session_id` | path | string | Required. Session id |

On success, `data` is `{ skills }`, where each item is a skill descriptor:

| Field | Type | Description |
| --- | --- | --- |
| `skills[].name` | string | Skill name |
| `skills[].description` | string | Skill description |
| `skills[].path` | string | Path of the skill. Same-name skills can be returned as several variants, each with a different `path` |
| `skills[].source` | string | `project` / `user` / `extra` / `builtin`. Skills provided by plugins are reported as `extra` |
| `skills[].workspace_dir` | string | Root directory of a project skill. Omitted for other sources |
| `skills[].type` | string | Skill category; optional. Only user-activatable types can be activated |
| `skills[].disable_model_invocation` | boolean | Optional. When `true`, the skill is hidden from the model |
| `skills[].scopes` | array | Optional. Client surfaces the skill applies to: `tui` / `web`. When omitted, it applies to all surfaces |

- `40401`: the session does not exist (or is not activated)

#### `POST /api/v1/sessions/{session_id}/skills/{skill_name}:activate`

Activates a skill in the session, the equivalent of the `/<skill>` slash command: starts a turn on the main agent with the skill's content plus `args` and attachments.

When the main agent is running, activation does not start a new turn. It is inserted into the current turn as steering, and the response returns after the insertion (see [Steering](#steering)).

The endpoint dispatches through one route, `POST /api/v1/sessions/{session_id}/skills/{tail}`: `{tail}` is parsed as `{skill_name}:{action}`, and `activate` is the only action. A bare name or an unknown action returns `40001` (`unsupported action: ...`).

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `session_id` | path | string | Required. Session id |
| `skill_name` | path | string | Required. Name of the skill to activate |
| `path` | body | string | Exact path of a `SKILL.md` in the session skill catalog, used to select a same-name variant. Must match an entry returned by the catalog |
| `args` | body | string | Free-form arguments passed to the skill, like the text after a slash command |
| `prompt_id` | body | string | Client-chosen id of the activation message. It appears in the `prompt_ids` of the matching `user_message` item in the conversation (see [Items](#items)). The idempotency rules are the same as for [`prompt_id` in prompt submission](#post-api-v1-sessions-session-id-prompts), and both share one record table |
| `metadata` | body | object | Client-defined metadata saved with the activation message, same as `metadata` in prompt submission |
| `attachments` | body | array | Media blocks attached to the activation. `image` / `video` blocks carry a `source` object whose `kind` is `url` / `base64` / `file` / `session_media`, in the same shape as [prompt content blocks](#post-api-v1-sessions-session-id-prompts); `file` blocks carry the top-level `file_id`, `name`, `media_type`, and `size` |

On success, `data` is `{ activated: true, skill_name }`.

- `40001`: validation failure, or an unsupported action suffix
- `40401`: the session does not exist (or is not activated)
- `40407`: a referenced attachment file does not exist
- `40415`: no skill with that name
- `40912`: the skill exists, but its type cannot be activated by the user
- `40927`: `prompt_id` is already used by another request, including prompt submission and `/steer` requests

## Conversation

These endpoints read the conversation history, submit prompts, and answer approvals and questions. Live conversation updates go over the WebSocket; see [Sessions and conversations](#sessions-and-conversations).

### Turns and agents

Page one agent's conversation by turns and items (the same model as the [turns](#turns) the WebSocket pushes live).

| Method and path | Description |
| --- | --- |
| `GET /api/v1/sessions/{session_id}/agents/{agent_id}/turns` | Page one agent's turns (`before_ordinal` / `page_size`) |

#### `GET /api/v1/sessions/{session_id}/agents/{agent_id}/turns`

Returns one page of an agent's turns, oldest first. For the shape of turns and items, see [Turns](#turns) and [Items](#items). When the session or a finished subagent is not in memory, reading loads it.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `session_id` | path | string | Required. Session id |
| `agent_id` | path | string | Required. Agent id, without path separators |
| `before_ordinal` | query | integer | Only turns whose `ordinal` is below this value. No turn needs to have that `ordinal` (for example after an undo). By default, the latest page is returned |
| `page_size` | query | integer | 1–200 turns. Default `50` |

On success, `data` is `{ turns, has_more }`. `has_more` means older turns remain; to read them, pass the `ordinal` of this page's first turn as `before_ordinal`.

A page is at most 1 MiB. When `page_size` turns do not fit, the oldest turns are left out and `has_more` is `true`; the newest turn is always included. The latest page holds the running turn, if any, with its content so far.

Each page is a snapshot taken when the request starts and can include turns that are later undone. After receiving a `turns.removed` frame, discard the results of page requests sent before it.

Tasks, the agent's running status and settings, context water-level, the goal, todos, and pending interactions are not part of turns. They arrive as the WebSocket `task`, `agent`, `context`, `goal`, `todo`, and `interaction` frames; see [Tasks](#tasks), [Agent state](#agent-state), and [Approvals and questions](#approvals-and-questions).

- `40001`: validation failure
- `40401`: the session or agent does not exist

### Prompts

A prompt is one unit of user input. A submitted prompt enters the queue of the session's main agent (or a specified agent); queued prompts can be steered into the active turn, and running or queued prompts can be aborted. Turn progress is pushed over the WebSocket (see [Live updates](#live-updates)), not through these endpoints.

| Method and path | Description |
| --- | --- |
| `GET /api/v1/sessions/{session_id}/prompts` | Active and queued prompts |
| `POST /api/v1/sessions/{session_id}/prompts` | Submit a prompt (content block array, with optional overrides such as model and permission mode) |
| `POST /api/v1/sessions/{session_id}/steer` | Steer message content directly into the active turn |
| `POST /api/v1/sessions/{session_id}/prompts:steer` | Steer queued prompts into the active turn |
| `POST /api/v1/sessions/{session_id}/prompts/{prompt_id}:abort` | Abort a running or queued prompt |

#### `GET /api/v1/sessions/{session_id}/prompts`

Reads a snapshot of the main agent's prompt queue. Other agents' queues are not included. Queue changes are not pushed over the WebSocket; read again when you need the latest state.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `session_id` | path | string | Required. Session id |

On success, `data` is `{ active, queued }`: `active` is the running prompt, `null` when idle; `queued` lists the waiting prompts in order. Each prompt object is:

| Field | Type | Description |
| --- | --- | --- |
| `prompt_id` | string | Prompt id |
| `user_message_id` | string | Id of the corresponding user message |
| `status` | string | `running` / `queued` / `blocked` / `failed` |
| `content` | array | Array of content blocks, in the format accepted by `POST /api/v1/sessions/{session_id}/prompts` |
| `created_at` | string | Creation time |
| `metadata` | object | The `metadata` attached when submitting the prompt or activating the skill; optional |

- `40401`: the session does not exist

#### `POST /api/v1/sessions/{session_id}/prompts`

Submits a user prompt to the session. The response does not wait for the turn to finish.

When the target agent is idle, its queue is empty, and it is not in the middle of an undo, a manual compaction, or a fork (only forking an idle agent puts it in this state), the prompt starts a turn immediately, and the response returns once the turn starts (`status` is `running`). Otherwise the prompt is queued, and the response returns immediately with `status` `queued`. Prompts submitted during an undo, compaction, or fork are also queued, not rejected. See [Starting or queueing](#starting-or-queueing).

The server first validates media references, then applies the overrides to the target agent in the order `model`, `thinking`, `permission_mode`, `swarm_mode`, `disabled_tools`, and finally enqueues the prompt. Overrides take effect when the prompt is accepted, whether or not the prompt is queued, and they persist afterwards. `permission_mode` changes only the target agent; unlike the [profile endpoint](#post-api-v1-sessions-session-id-profile), it is not synced to all agents.

With `skills`, the prompt runs as a bundled skill activation instead of a plain user prompt.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `session_id` | path | string | Required. Session id |
| `content` | body | array | Required. Non-empty array of content blocks; variants below |
| `agent_id` | body | string | Target agent. Default the main agent |
| `prompt_id` | body | string | Client-chosen prompt id that makes the submission idempotent, also with `skills`. Rules below |
| `skills` | body | array | Bundled skill activations, at least 1 entry, each `{ name, path?, args? }`. Every skill must exist and be user-activatable. `path` selects a same-name variant from the session skill catalog |
| `model` | body | string | Model alias to switch to |
| `thinking` | body | string | Thinking effort level |
| `permission_mode` | body | string | `manual` / `yolo` / `auto` |
| `swarm_mode` | body | boolean | Enter or exit swarm mode |
| `disabled_tools` | body | array | Tool names to disable for the session |
| `metadata` | body | object | Client-defined metadata, saved with the prompt and returned in the prompt object's `metadata` |

The schema also accepts `plan_mode`, `goal_objective`, and `goal_control`, but the submit endpoint currently does not apply them.

The idempotency rules for `prompt_id` are as follows; see [Retries and idempotency](#retries-and-idempotency) for the flow:

- The server uses the endpoint plus the full request body as the request fingerprint; key order does not affect it. The same id with a different fingerprint returns `40927`.
- `/prompts`, `/steer`, and [`skills/{skill_name}:activate`](#post-api-v1-sessions-session-id-skills-skill-name-activate) share one record table within a session, so using the same id on another endpoint also returns `40927`.
- A resend with the same fingerprint returns the first result, waiting for the first request if it is still being processed. A resend does not apply the overrides again.
- When the first request failed before being enqueued, a resend is handled as a new request; when it failed after being enqueued, a resend returns the same error.
- Records are kept only in memory, at most 256 per session; beyond that, the oldest finished records are evicted. Records are cleared when the server restarts or the session is deleted.
- Requests without `prompt_id` have no idempotency protection.

Each `content` block is an object discriminated by `type`:

| Block | Fields | Description |
| --- | --- | --- |
| `text` | `text` | Plain text |
| `image` / `video` | `source` | Media input; forms of `source` below |
| `file` | `file_id`, `name`, `media_type`, `size` | A file attachment uploaded through [`POST /api/v1/files`](#file-uploads) |

`source` takes one of these forms:

- `{ kind: "url", url, id? }`
- `{ kind: "base64", media_type, data }`
- `{ kind: "file", file_id }`: an upload from `POST /api/v1/files`
- `{ kind: "session_media", file_id }`: media already committed to this session

The schema also accepts the `tool_use`, `tool_result`, and `thinking` blocks of the shared message format, but they are not meaningful in a user prompt. When a `file_id` reference is unknown or does not match the block's media kind, the server rejects the request before creating the prompt and before applying any override.

On success, `data` is the accepted prompt; see the prompt object in [`GET /api/v1/sessions/{session_id}/prompts`](#get-api-v1-sessions-session-id-prompts) for its shape. A prompt that starts immediately can still end before its turn starts: `status` is `blocked` when a hook rejected the prompt, and `failed` when submission failed before the turn started, for example because a prompt hook errored or an attachment could not be prepared.

- `40001`: validation failure, for example an unknown `model`, a `thinking` level the model does not support, or a `profile` field (the agent profile can only be chosen when the session is created)
- `40110`: no provider is configured yet (finish login first)
- `40111`: the resolved provider has no credential (`details.provider_id`)
- `40112`: the provider's credential was rejected (`details.provider_id`)
- `40113`: the model cannot be resolved (with `details.model_id` / `details.provider_id` when known), or the session has no model and only `thinking` is set without `model`
- `40401`: the session does not exist
- `40407`: a referenced `file_id` does not exist, or does not match the block's media kind
- `40415`: a `skills` entry points to an unknown skill
- `40912`: the skill exists but cannot be activated by the user
- `40927`: `prompt_id` is already used by another request

#### `POST /api/v1/sessions/{session_id}/steer`

Steers message content directly into the active turn. It takes one request, with no need to submit a prompt first and then steer it by id.

When the target agent has no running turn, it behaves like a plain submission. When a turn is running, the response returns after the message is actually inserted at the next steering point; if that turn ends first, the response returns once the follow-up turn starts. See [Steering](#steering).

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `session_id` | path | string | Required. Session id |

The body fields are the same as [`POST /api/v1/sessions/{session_id}/prompts`](#post-api-v1-sessions-session-id-prompts), including `content`, `agent_id`, `prompt_id`, `skills`, `model`, `thinking`, `permission_mode`, `swarm_mode`, `disabled_tools`, and `metadata`. Media references and bundled skills also reuse the validation and preparation flow of prompt submission.

The order and effect of applying overrides and the `prompt_id` idempotency rules are the same as for prompt submission.

On success, `data` has the same shape as the accepted prompt returned by prompt submission. Errors also match prompt submission, including validation, media, environment, and idempotency errors.

#### `POST /api/v1/sessions/{session_id}/prompts:steer`

Steers queued prompts into the active turn, so the running turn consumes them immediately instead of waiting for the current turn to finish.

Available only when the main agent has a running turn. Without a running turn, it returns `40402` even if the prompts are in the queue. Multiple ids are validated as a whole: when any id is not in the queue or appears more than once, no prompt is steered.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `session_id` | path | string | Required. Session id |
| `prompt_ids` | body | array | Required. Non-empty array of queued prompt ids |

On success, `data` is `{ steered: true, prompt_ids }`.

- `40001`: validation failure
- `40401`: the session does not exist
- `40402`: the main agent has no running turn, or an id is not in the queue or appears more than once

#### `POST /api/v1/sessions/{session_id}/prompts/{prompt_id}:abort`

Aborts one of the main agent's prompts:

- When the prompt is running, the effect is the same as stopping the current turn with [`:cancel`](#post-api-v1-sessions-session-id-cancel).
- When the prompt is queued, it is removed from the queue; no turn is produced and no frame is sent.
- When the prompt has ended or the id is unknown, `40402` is returned.

This endpoint goes through `POST /api/v1/sessions/{session_id}/prompts/{tail}`: `{tail}` is parsed as `{prompt_id}:{action}` with `abort` as the sole action, and a missing or unknown action returns `40001` (`unsupported action: ...`).

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `session_id` | path | string | Required. Session id |
| `prompt_id` | path | string | Required. Prompt id |

On success, `data` is `{ aborted: true }`.

- `40401`: the session does not exist
- `40402`: the prompt has ended, or there is no prompt with that id

### Approvals and questions

Approvals and questions are the two kinds of interaction in a session that wait for a user answer: an approval asks permission for a tool call, and a question asks for structured input with labeled options. Pending interactions arrive as WebSocket `interaction` frames (see [Approvals and questions](#approvals-and-questions)), and clients answer them with the endpoint below.

| Method and path | Description |
| --- | --- |
| `POST /api/v1/sessions/{session_id}/interactions/{interaction_id}` | Answer a pending approval or question |

#### `POST /api/v1/sessions/{session_id}/interactions/{interaction_id}`

Answers a pending interaction, letting the waiting tool call continue. The body's `kind` must match the interaction's type.

The first answer wins; later answers return `40902`. The server remembers only interactions that ended within the last 60 seconds, at most 256 of them; answering beyond that returns `40404`. Clients should treat both error codes as "the interaction has ended". See [Approvals and questions](#approvals-and-questions) for the flow.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `session_id` | path | string | Required. Session id |
| `interaction_id` | path | string | Required. The `interaction_id` from the `interaction` frame |
| `kind` | body | string | Required. `approval` or `question` |

To answer an approval, use these fields:

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `decision` | body | string | Required. `approved` / `rejected` / `cancelled` |
| `scope` | body | string | Used with `approved`. The only value is `session`, which remembers the approval rule for the rest of the session |
| `feedback` | body | string | Free-form feedback passed back to the agent |
| `selected_label` | body | string | The label of the chosen option, when the request offered labeled options (for example a plan review) |

To answer a question, use exactly one of `answers` and `dismissed`:

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `answers` | body | object | Map from question item `id` (from `request.questions` in the frame) to an answer object; answer variants in the table below |
| `dismissed` | body | boolean | When `true`, dismisses the question without answering |
| `method` | body | string | How the answer was produced: `enter` / `space` / `number_key` / `click` |

Each answer is an object discriminated by `kind`:

| `kind` | Fields | Description |
| --- | --- | --- |
| `single` | `option_id` | One chosen option |
| `multi` | `option_ids` | Several chosen options, at least 1 |
| `other` | `text` | A free-text answer |
| `multi_with_other` | `option_ids`, `other_text` | Options plus free text |
| `skipped` | — | The item was skipped |

The server does not validate question answers: an unknown option id is passed to the agent as-is as answer text, and an unknown question item id is kept as-is as a key.

On success, `data` is `{ outcome, ended_at }`: for an approval, `outcome` is `approved` / `rejected` / `cancelled`; for a question, `answered` / `dismissed`. Subscribers also receive the interaction's last `interaction` frame.

- `40001`: validation failure (`details` lists each field), or `kind` does not match the interaction's type
- `40401`: the session does not exist
- `40404`: no interaction with that id in the session, including interactions that ended more than 60 seconds ago or fell beyond the record limit
- `40902`: the interaction has already ended

---

# Service and configuration endpoints

This section lists the service-level endpoints that are not bound to a single session, plus the configuration endpoints. Session endpoints are in [Session endpoints](#session-endpoints), and file endpoints are in [File endpoints](#file-endpoints). Shared conventions such as authentication, the response envelope, error codes, and pagination are in [Overview](#kimi-agent-protocol-kap-reference-beta).

A `:{action}` suffix in a path is the action convention: POST to `path:action` on a single resource or a resource collection to run a non-CRUD operation (such as `:fork` and `:archive` on a session, or `:refresh` on the provider collection).

## Server and metadata

These endpoints report information about the server instance itself and provide liveness and shutdown entry points.

| Method and path | Description |
| --- | --- |
| `GET /api/v1/healthz` | Liveness probe; auth-exempt |
| `GET /api/v1/meta` | Server version, capability map, `server_id`, experimental flags |
| `POST /api/v1/shutdown` | Graceful shutdown (replies 200 first); mounted only on a loopback bind or with `--allow-remote-shutdown` |

### `GET /api/v1/healthz`

Liveness probe for scripts and process supervisors. It is the only `/api` endpoint that does not require the bearer token (see [Authentication](#authentication)), and it answers without touching config or the engine.

On success, `data` is `{ "ok": true }`.

### `GET /api/v1/meta`

Returns this instance's identity and capability map. Most fields are frozen at boot. `experimental_flags` and `features` are resolved on every request, so a flag flip or a failed feature shows up in the next response.

| Field | Type | Description |
| --- | --- | --- |
| `kimi_agent_protocol_version` | string | Kimi Agent Protocol version (currently `"0.1.0"`) |
| `server_version` | string | Server version |
| `capabilities` | object | Capability map: `websocket`, `file_upload`, `fs_query`, `mcp`, `tasks`, all always `true` |
| `server_id` | string | Unique id of this server instance |
| `started_at` | string | Boot time, ISO 8601 |
| `open_in_apps` | array | Host apps usable as `open-in` targets: `finder` / `cursor` / `vscode` / `iterm` / `terminal`. Currently always empty |
| `dangerous_bypass_auth` | boolean | Whether the server was started with `--dangerous-bypass-auth` (when `true`, clients may skip the token prompt) |
| `web_title` | string | Custom browser tab title from `--web-title`; omitted when unset |
| `experimental_flags` | object | Experimental flag id → enabled, resolved at request time |
| `features` | array | Engine features, each `{ name, state, meta }`. `state` is `Pending` / `Activating` / `Active` / `Unloading` / `Failed` |

### `POST /api/v1/shutdown`

Asks the server to shut down gracefully. The server sends the response first and shuts down immediately after, so the caller can trust the response it received.

The route is mounted only when the server is bound to a loopback address or was started with `--allow-remote-shutdown`. Otherwise the route is not registered and requests get a 404.

On success, `data` is `{ "ok": true }`.

## Login and usage

These endpoints drive the managed Kimi OAuth login lifecycle and read account-level information. The managed provider is named `managed:kimi-code`, and the optional `provider` parameter on every endpoint below defaults to it.

| Method and path | Description |
| --- | --- |
| `GET /api/v1/auth` | Auth status snapshot |
| `POST /api/v1/oauth/login` | Start the OAuth device-code login flow |
| `GET /api/v1/oauth/login` | Poll the login flow state |
| `DELETE /api/v1/oauth/login` | Cancel a pending login flow |
| `POST /api/v1/oauth/logout` | Log out the managed provider |
| `GET /api/v1/oauth/usage` | Plan quota and booster wallet |
| `GET /api/v1/oauth/userinfo` | Account profile |
| `GET /api/v1/oauth/region` | Resolve the client region (`mainland-cn` / `global`) |

### `GET /api/v1/auth`

Returns an auth status snapshot: whether the default model resolves to a usable provider configuration, and the managed provider's login state.

`models_ready` is `true` when the global `default_model` alias exists in the model table and resolves to a configured provider. Providerless flat models that carry their own `base_url` and models injected through `KIMI_MODEL_*` environment variables both count. The server does not verify credentials, so later conversation requests can still fail with `40111` / `40112`.

| Field | Type | Description |
| --- | --- | --- |
| `models_ready` | boolean | Whether the default model resolves to a configured provider; see the rule above |
| `providers_count` | integer | Number of configured providers |
| `managed_provider` | object \| null | Login state of the managed provider |
| `managed_provider.name` | string | Managed provider name |
| `managed_provider.status` | string | `authenticated` / `expired` / `revoked` / `unauthenticated` |

This endpoint does not return the global default model alias. Read it from `default_model` in [`GET /api/v1/config`](#configuration) instead.

### `POST /api/v1/oauth/login`

Starts an OAuth device-code login flow for the managed provider. Starting a new flow aborts any pending flow for the same provider. When the account is already logged in, no user interaction is needed and the response reports `authenticated` directly.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `provider` | body | string | Managed provider name. Default `managed:kimi-code` |
| `region` | body | string | `mainland-cn` / `global`. Overrides the region resolved by [`GET /api/v1/oauth/region`](#get-api-v1-oauth-region) for this flow only |

On success, `data.status` is `pending` or `authenticated`. When the account is already logged in, `data` has only `flow_id`, `provider`, and `status: "authenticated"`. For a pending flow, `data` has these fields:

| Field | Type | Description |
| --- | --- | --- |
| `flow_id` | string | Flow id |
| `provider` | string | Managed provider name |
| `status` | string | `pending` |
| `verification_uri` | string | Verification page URL; open it and enter `user_code` |
| `verification_uri_complete` | string | Verification page URL that can be opened directly, without entering `user_code` |
| `user_code` | string | User code to enter on the `verification_uri` page |
| `expires_in` | integer | Flow deadline in seconds. The same deadline as `expires_at` |
| `interval` | integer | Polling interval in seconds |
| `expires_at` | string | Flow expiry time |

With a pending flow, open `verification_uri_complete` (or open `verification_uri` and enter `user_code`), then poll `GET /api/v1/oauth/login` every `interval` seconds until the flow resolves or `expires_at` passes.

### `GET /api/v1/oauth/login`

Polls the login flow state for a provider.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `provider` | query | string | Managed provider name. Default `managed:kimi-code` |

When no flow has been started, `data` is `null`. Otherwise `data` is a flow snapshot with every field of the pending shape of `POST /api/v1/oauth/login`. These fields differ in value or are added:

| Field | Type | Description |
| --- | --- | --- |
| `status` | string | `pending` / `authenticated` / `denied` / `expired` / `cancelled` |
| `resolved_at` | string | Present once the flow leaves `pending`; records when the flow reached its terminal state |
| `error_message` | string | Describes a failed flow; may be omitted |

### `DELETE /api/v1/oauth/login`

Cancels the pending login flow for a provider. When no flow is pending, the call does nothing and returns the last known state.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `provider` | query | string | Managed provider name. Default `managed:kimi-code` |

On success, `data` is `{ cancelled, status }`. `cancelled` is `true` only when a `pending` flow was actually aborted. `status` is the flow state after the call.

### `POST /api/v1/oauth/logout`

Logs out the managed provider: discards the stored OAuth credential, aborts any pending login flow, and removes the managed provider from the configuration. OAuth-managed providers cannot be edited or deleted manually (see [`PUT` / `DELETE /api/v1/providers/{provider_id}`](#models-and-providers)), so the only way to remove one is to log out first.

When you log out the default Kimi provider (`managed:kimi-code`), the server also tears down this machine's Remote Control and clears cached Remote Control cloud sessions. Logging out any other provider does not affect Remote Control. The teardown order depends on who hosts the tunnel:

- **No tunnel is running, or another process on this machine hosts it**: the server first takes this machine's device offline and holds the machine lock, so no process on this machine can start Remote Control again before the credential is discarded. If the cleanup fails, the logout is aborted.
- **This server hosts the tunnel**: the server discards the credential first and tears down the tunnel right after the response is sent, so a logout sent through the Remote Control link still receives its response.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `provider` | body | string | Managed provider name. Default `managed:kimi-code` |

On success, `data` is `{ logged_out: true, provider }`.

- `50001`: logging out the default Kimi provider failed, either in the Remote Control cleanup or in the logout itself

### `GET /api/v1/oauth/usage`

Reads the plan quota and booster wallet of the managed account, fetched live from the account service. When the account service fails, the envelope still succeeds and the error comes back inside `data`.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `provider` | query | string | Managed provider name. Default `managed:kimi-code` |

On success, `data.kind` is `ok` or `error`:

| Field | Type | Description |
| --- | --- | --- |
| `quota.usages` | object | `ok` only: usage per time window, keyed by `limit5h`, `limit7d`, `monthTotal`, `monthCode`; clients render whichever keys are present. Each entry is `{ usedRatio, resetAt? }`: `usedRatio` is the used fraction from 0 to 1 (a float), and `resetAt` is the reset time in RFC3339 format |
| `quota.extraUsage` | object \| null | `ok` only: the pay-as-you-go wallet, with fields `balanceCents`, `totalCents`, `monthlyChargeLimitEnabled`, `monthlyChargeLimitCents`, `monthlyUsedCents`, `currency` |
| `message` | string | `error` only: error message |
| `status` | integer | `error` only: HTTP status code returned by the account service; omitted when there is none |

### `GET /api/v1/oauth/userinfo`

Reads the managed account's profile. Account service failures are handled the same way as in [`GET /api/v1/oauth/usage`](#get-api-v1-oauth-usage): the envelope still succeeds and the error comes back inside `data`.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `provider` | query | string | Managed provider name. Default `managed:kimi-code` |

On success, `data.kind` is `ok` or `error`:

| Field | Type | Description |
| --- | --- | --- |
| `userInfo` | object | `ok` only: account profile. Always contains `userId`, `nickname`, `status`, `region`, `userLevel`, `userLevelName`, `domain`, `domainName`; may add `globalId`, `bio`, `avatar`, `username`, `email`, `phone` (`{ countryCode, number }`), `createdTime`, and `lastLoginTime` |
| `message` | string | `error` only: error message |
| `status` | integer | `error` only: HTTP status code returned by the account service; omitted when there is none |

### `GET /api/v1/oauth/region`

Resolves which Kimi region the client belongs to. The result is derived locally, without network probes. The server takes the first input that decides the region, in this order: an OAuth host pinned by environment variable or config, the configured OAuth key, and the install-channel marker in `<home>/region`.

When the client is logged out and none of those inputs decides the region, the server infers it from the device time zone and locale. When the inference gives a definite result, the server caches it in `<home>/region.json` and uses the cache from then on; the cache is cleared after the client logs in. Raw time zone and locale values are not uploaded.

When signals are missing or conflicting, the current process falls back to `mainland-cn` without persisting that result, and the next start decides again. Set `KIMI_CODE_REGION_MARKER=off` to disable both the install-channel marker and local inference. Local inference is also skipped when `KIMI_CODE_BASE_URL` is set.

On success, `data` is `{ region }`, where `region` is `mainland-cn` / `global`.

## Remote Control

These endpoints manage the machine-wide Remote Control tunnel (see the [Remote Control guide](https://moonshotai.github.io/kimi-code/en/guides/remote-control.html)) and the account's device registry. Tunnel state is per machine. The device registry is per account and stored in the cloud, so device endpoints require a Kimi login; the server holds the login session and proxies requests to the relay, so OAuth credentials never reach the caller.

| Method and path | Description |
| --- | --- |
| `GET /api/v1/remote-control` | Read the tunnel status |
| `POST /api/v1/remote-control` | Start or stop the tunnel |
| `GET /api/v1/remote-control/devices` | List the account's devices |
| `PATCH /api/v1/remote-control/devices/{id}` | Rename a device |
| `POST /api/v1/remote-control/devices/{id}/deactivate` | Take a device offline |
| `DELETE /api/v1/remote-control/devices/{id}` | Remove a device from the registry |

### `GET /api/v1/remote-control`

Returns the current tunnel status. When the tunnel is off but another live process on this machine holds the single-instance lock, `data.conflict` carries the lock holder's information. While the tunnel is off, every read re-checks the lock; once the holder process exits, `conflict` and any stored `error` are cleared together.

On success, `data` is the tunnel status object:

| Field | Type | Description |
| --- | --- | --- |
| `enabled` | boolean | Remote Control switch |
| `state` | string | `off` / `starting` / `on` / `stopping` |
| `url` | string | Tunnel URL; may be omitted |
| `device_id` | string | This machine's device identifier; may be omitted |
| `device_name` | string | This machine's device name; may be omitted |
| `error` | string | Error message; may be omitted |
| `conflict` | object | Lock holder information, present only in the conflict case above: `{ pid, local_origin, device_id, url, started_at }` |

### `POST /api/v1/remote-control`

Starts or stops the tunnel.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `enabled` | body | boolean | `true` to start the tunnel, `false` to stop it |

On success, `data` is the tunnel status object, the same as `GET /api/v1/remote-control`.

- `40001` (`VALIDATION_FAILED`): on start, the server is not bound to a loopback address, or it was started with `--dangerous-bypass-auth`
- `40928` (`REMOTE_CONTROL_ALREADY_RUNNING`): on start, another live process on this machine holds the single-instance lock. `details` carries the lock holder information, in the same shape as `conflict`
- `50001` (`INTERNAL_ERROR`): starting or stopping the tunnel failed

### `GET /api/v1/remote-control/devices`

Lists the account's Remote Control devices from the cloud registry.

On success, `data` is `{ devices, max_devices? }`, where `max_devices` is the device limit. Each item in `devices` has these fields:

| Field | Type | Description |
| --- | --- | --- |
| `device_id` | string | Device identifier |
| `alias` | string | Display name |
| `status` | string | `online` / `offline` |
| `platform` | string | Device platform |
| `client_version` | string | Client version |
| `local_base_url` | string | Device's local server URL |
| `created_at` | string | Creation time |
| `updated_at` | string | Update time |
| `last_remote_access_at` | string | Time of the most recent remote access |

- `50001` (`INTERNAL_ERROR`): the request to the cloud registry failed

### `PATCH /api/v1/remote-control/devices/{id}`

Renames a device.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `id` | path | string | Device identifier |
| `alias` | body | string | New display name, 1–50 characters after trimming leading and trailing whitespace |

On success, `data` is `{ ok: true }`.

- `40001` (`VALIDATION_FAILED`): the name is blank or too long. The server returns this before contacting the cloud
- `50001` (`INTERNAL_ERROR`): the request to the cloud registry failed

### `POST /api/v1/remote-control/devices/{id}/deactivate`

Marks a device offline in the cloud registry. Offline devices stay in the list and do not consume the plan's device quota; a device comes back online the next time it turns on Remote Control.

When the target device is this machine, the server first stops the local tunnel (an in-flight start is cancelled), then holds the machine lock while deactivating, so a concurrent start cannot re-register the device after the success response.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `id` | path | string | Device identifier |

On success, `data` is `{ ok: true }`.

- `50001` (`INTERNAL_ERROR`): the request to the cloud registry failed. Also returned instead of success when the target device is this machine and the lock holder does not stop within the time limit

### `DELETE /api/v1/remote-control/devices/{id}`

Removes a device from the cloud registry: the device disappears from the list, and a tunnel that is still connected is disconnected. Unlike [deactivating](#post-api-v1-remote-control-devices-id-deactivate), deleting does not keep the device in the list.

When the target device is this machine, the server first stops the local tunnel, then holds the machine lock while deleting, so the device cannot re-register after the success response.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `id` | path | string | Device identifier |

On success, `data` is `{ ok: true }`.

- `50001` (`INTERNAL_ERROR`): the request to the cloud registry failed. Also returned when the target device is this machine and the lock holder does not stop within the time limit

## Configuration

These endpoints read and write the global configuration (`config.toml`).

| Method and path | Description |
| --- | --- |
| `GET /api/v1/config` | Read the global config (secret fields redacted) |
| `POST /api/v1/config` | Merge-patch the config and broadcast `config` |

### `GET /api/v1/config`

Returns the resolved global configuration: the effective result of `config.toml` plus overlays. Secrets are redacted: each provider reports only `has_api_key`, never the stored key.

On success, `data` is the config object. Its fields map one-to-one to the top-level domains in [Top-level fields](https://moonshotai.github.io/kimi-code/en/configuration/config-files.html#top-level-fields):

| Field | Type | Description |
| --- | --- | --- |
| `providers` | object | Map of provider id → `{ type, base_url?, default_model?, api_key_env?, has_api_key }` |
| `default_provider` | string | Global default provider id |
| `default_model` | string | Global default model alias |
| `models` | object | Map of model alias → model record |
| `thinking` | object | Default parameters for Thinking mode |
| `plan_mode` | boolean | Plan mode switch |
| `yolo` | boolean | Derived: `true` when `default_permission_mode` is `yolo` |
| `default_permission_mode` | string | Default permission mode for new sessions |
| `default_plan_mode` | boolean | Whether new sessions start in Plan mode |
| `permission` | object | Initial permission rules |
| `hooks` | array | Lifecycle hooks |
| `services` | object | Built-in external service configuration |
| `merge_all_available_skills` | boolean | Whether to merge Agent Skills from all available directories |
| `extra_skill_dirs` | array | Extra skill search directories |
| `loop_control` | object | Agent loop control parameters |
| `background` | object | Background task runtime parameters |
| `subagent` | object | Subagent configuration |
| `secondary_model` | object | Secondary model pool for subagents |
| `experimental` | object | Experimental flag id → enabled |
| `telemetry` | boolean | Whether anonymous telemetry is enabled |
| `auto_session_title` | boolean | Whether clients may automatically generate session titles |
| `disable_feedback_survey` | boolean | Whether the session rating prompt is turned off |
| `raw` | object | Raw parsed `config.toml` content, unmodeled fields included |

### `POST /api/v1/config`

Merge-patches the global configuration. Each top-level domain in the request body is deep-merged into the matching domain, and domains absent from the body stay unchanged.

The request body is a partial config object: it may contain any top-level domain of the [`GET /api/v1/config`](#get-api-v1-config) response except `raw`, all optional, with the same types and meanings as the response table. Two domains have extra write rules:

- **`yolo`**: `true` is shorthand for `default_permission_mode: "yolo"`; `false` is ignored.
- **`default_permission_mode`**: one of `manual` / `yolo` / `auto`.

On success, `data` is the full updated config, in the same shape as `GET /api/v1/config`.

Every config change broadcasts the global event `config` (see [Global events](#global-events)). This covers a successful update through this endpoint, an edit of `config.toml` outside the process, and server-side writes such as an OAuth login refresh. Changes within a short window are merged. The frame carries the full current config projection (same shape as the `GET /api/v1/config` response), with any warnings from config loading in the optional `warnings` field.

- `40001`: the patch was rejected (invalid value or persistence failure); the response carries the underlying error message

## Models and providers

These endpoints manage the two halves of model configuration in `config.toml`: the [providers](https://moonshotai.github.io/kimi-code/en/configuration/providers.html) table and the model alias table. A server-proxied models.dev directory is also available for one-shot provider imports.

A model alias id is the alias key in the configuration. Aliases created through the provider-management endpoints take the form `provider_id/model` (for example `my-provider/kimi-for-coding`), while a bare key in the model alias table (such as `turbo`) is used as-is. Anywhere the API takes a `model_id`, including the global `default_model`, it means this alias id.

An unsupported action on a `:{action}` route returns `40001`.

| Method and path | Description |
| --- | --- |
| `GET /api/v1/models` | List configured model aliases |
| `POST /api/v1/models/{model_id}:set_default` | Set the global default model |
| `GET /api/v1/providers` | List providers |
| `POST /api/v1/providers` | Create a provider (201) |
| `GET /api/v1/providers/{provider_id}` | Read a provider (includes the stored key) |
| `PUT /api/v1/providers/{provider_id}` | Replace a provider's configuration |
| `DELETE /api/v1/providers/{provider_id}` | Delete a provider (204) |
| `POST /api/v1/providers/{provider_id}:refresh` | Refresh this provider's model metadata |
| `POST /api/v1/providers:{action}` | Collection actions: `refresh` / `refresh_oauth` / `import_catalog` (201) / `import_registry` (201) |
| `GET /api/v1/catalog/providers` | Browse the models.dev directory (server-proxied) |
| `GET /api/v1/catalog/providers/{catalog_id}` | Read one directory entry |

### `GET /api/v1/models`

Lists the configured model aliases across all providers.

On success, `data.items` is an array of models, each with these fields:

| Field | Type | Description |
| --- | --- | --- |
| `provider` | string | Owning provider id |
| `model` | string | Alias id: `provider_id/model` for provider-managed aliases, otherwise the bare key |
| `display_name` | string | Display name; may be omitted |
| `max_context_size` | integer | Context window in tokens |
| `capabilities` | array | Capability flags; may be omitted |
| `support_efforts` | array | Supported Thinking mode effort levels; may be omitted |
| `default_effort` | string | Default effort level; may be omitted |
| `upgrade` | object | May be present on custom registry models, to guide users toward a replacement model |
| `upgrade.model` | string | Replacement model |
| `upgrade.migration_markdown` | string | Migration notes, with placeholders already replaced by model ids |
| `upgrade.retirement_at` | string | Retirement time; may be omitted |

### `POST /api/v1/models/{model_id}:set_default`

Sets the global `default_model` to an existing alias. `model_id` is the exact alias key from the configuration. For a bare key the call is `POST /api/v1/models/turbo:set_default`; URL-encode the id when it contains `/`, as in `POST /api/v1/models/my-provider%2Fkimi-for-coding:set_default`.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `model_id` | path | string | Required. The exact model alias key from the configuration; URL-encode it when it contains `/` |

On success, `data` is `{ default_model, model }`: `default_model` is the alias now in effect, and `model` is its catalog item (same shape as a `GET /api/v1/models` item).

- `40001`: malformed or unsupported action suffix in the path
- `40413`: no model alias with that id

### `GET /api/v1/providers`

Lists every configured provider with its credential and model-discovery state, without revealing any key. This item shape is also the "provider item" referenced by the other provider endpoints.

On success, `data.items` is an array of provider items:

| Field | Type | Description |
| --- | --- | --- |
| `id` | string | Provider id |
| `type` | string | Wire protocol, returned as the value in the configuration (for values written through these endpoints, see `type` in `POST /api/v1/providers`); `openai` when the configuration does not set it |
| `base_url` | string | API base URL; omitted when unset |
| `default_model` | string | The provider's default model alias. When the provider does not set one but the global `default_model` belongs to this provider, the global value is used; otherwise omitted |
| `api_key_env` | string | Name of the environment variable the API key is read from; omitted when unset |
| `has_api_key` | boolean | Whether a usable API key exists: a non-empty `api_key` is configured, the environment variable named by `api_key_env` has a value, or the provider's `env` supplies a key |
| `status` | string | `error` when the credential configuration conflicts (`api_key` and `api_key_env` both present, or either one present together with OAuth); otherwise `connected` when an API key or a cached OAuth token exists, and `unconfigured` when neither does |
| `models` | array | The provider's model alias ids |

### `POST /api/v1/providers`

Creates a provider and its model aliases in one save. On success, the reply is HTTP 201 with the standard envelope. When no global `default_model` is configured at all (a fresh install), the server seeds it with the new provider's `default_model` (or first model); an existing default is never modified.

Credentials are one of two forms: `api_key` stores the key directly, while `api_key_env` records the name of the environment variable to read the key from. A request that passes non-empty values for both is rejected.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `id` | body | string | Required. Provider id. Only letters, digits, `-`, `_`, and spaces; must start with a letter or digit |
| `type` | body | string | Required. Wire protocol: `kimi` / `openai` / `openai_responses` / `anthropic` / `bedrock` / `google-genai` / `vertexai` |
| `api_key` | body | string | API key, stored in `config.toml` |
| `api_key_env` | body | string | Name of the environment variable to read the API key from. The server stores only the variable name, not the key |
| `base_url` | body | string | API base URL; must not contain an environment variable placeholder (`${...}`) |
| `default_model` | body | string | The provider's default model; must be one of `models[].model` |
| `models` | body | array | Required. At least one entry, no duplicate `model` values; entry shape below |

Each `models[]` entry declares one alias whose id is `id/model`:

| Field | Type | Description |
| --- | --- | --- |
| `model` | string | Required. Upstream model name |
| `max_context_size` | integer | Required. Context window in tokens, ≥ 1 |
| `display_name` | string | Display name |
| `capabilities` | array | Capability flags such as `thinking` or `image_in` |
| `protocol` | string | Wire-protocol override: `anthropic`, `openai`, or `openai_responses`; inferred from the model ID when omitted |
| `max_output_size` | integer | Max output tokens, ≥ 1 |
| `support_efforts` | array | Supported Thinking mode effort levels |
| `adaptive_thinking` | boolean | Adaptive thinking switch |

On success, `data` is the created provider item (same shape as a `GET /api/v1/providers` item).

- `40001`: body validation failed, or both `api_key` and `api_key_env` were passed with non-empty values
- `40921`: a provider with this `id` already exists

### `GET /api/v1/providers/{provider_id}`

Reads one provider. Unlike the list endpoint, the response includes the stored `api_key` when one is set, so a local edit form can prefill it. Keep this in mind when exposing the server port.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `provider_id` | path | string | Required. Provider id |

On success, `data` is the provider item, plus `api_key` when a key is stored.

- `40412`: provider not found

### `PUT /api/v1/providers/{provider_id}`

Replaces a provider in one save. `type`, `base_url`, and the model list are rewritten, and the provider's aliases are rebuilt from `models`: aliases no longer listed disappear from `config.toml`, while other providers' aliases are untouched. Apart from the migration caused by a `new_id` rename, this endpoint does not modify the global default pointers.

`api_key` and `api_key_env` each accept three forms: omitted keeps the stored value, `""` clears it, and any other value replaces it. The two are mutually exclusive: a non-empty value for one clears the other, and a request with non-empty values for both is rejected.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `provider_id` | path | string | Required. Current provider id |
| `new_id` | body | string | Rename the provider. The providers key, model aliases, `default_provider`, a `default_model` pointing at an old alias, and the subagent secondary model pool all migrate. Same id rules as `POST /api/v1/providers` |
| `type` | body | string | Required. Wire protocol: `kimi` / `openai` / `openai_responses` / `anthropic` / `bedrock` / `google-genai` / `vertexai` |
| `api_key` | body | string | API key; three forms, see above |
| `api_key_env` | body | string | Name of the environment variable to read the API key from; three forms, see above |
| `base_url` | body | string | API base URL; must not contain an environment variable placeholder (`${...}`) |
| `default_model` | body | string | The provider's default model; must be one of `models[].model` |
| `models` | body | array | Required. At least one entry, no duplicate `model` values; same entry shape as `POST /api/v1/providers` |

On success, `data` is `{ provider }`, where `provider` is the saved provider item.

- `40001`: body validation failed, both `api_key` and `api_key_env` were passed with non-empty values, or a renamed alias id would collide with another provider's alias
- `40003`: the provider is OAuth-managed; log out with `POST /api/v1/oauth/logout` instead
- `40412`: provider not found
- `40921`: `new_id` is already taken

### `DELETE /api/v1/providers/{provider_id}`

Deletes a provider and all of its model aliases, and cascades the cleanup to the subagent secondary model pool. The global `default_provider` / `default_model` pointers stay unchanged, even when they point at the deleted provider. These two values are the user's settings, and this endpoint does not reclaim them.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `provider_id` | path | string | Required. Provider id |

On success, the server returns HTTP 204 with no body; the status code itself reports the successful delete (see [Response envelope](#response-envelope)).

- `40003`: the provider is OAuth-managed; log out with `POST /api/v1/oauth/logout` instead
- `40412`: provider not found

### `POST /api/v1/providers/{provider_id}:refresh`

Re-discovers one provider's model metadata from its upstream source and rewrites the provider's aliases. A provider with a static model source makes no network request and is reported as `unchanged` directly.

This endpoint and the collection-level `:refresh` and `:refresh_oauth` follow the same broadcast rule. When the refresh report's `changed` is non-empty (at least one provider's aliases or managed model metadata changed), the server broadcasts the global event `invalidated` with `kind: "models"` (see [Global events](#global-events)); clients then refetch `GET /api/v1/models`.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `provider_id` | path | string | Required. Provider id |

On success, `data` is a refresh report:

| Field | Type | Description |
| --- | --- | --- |
| `changed` | array | Providers that changed, each `{ provider_id, provider_name, added, removed }`; `added` / `removed` are the numbers of aliases added / removed |
| `unchanged` | array | Ids of providers with no diff |
| `failed` | array | Providers whose refresh failed, each `{ provider, reason }` |
| `retired_default` | object | Optional. Present when the refresh finds that the registry dropped the current default model and that model had declared an `upgrade` replacement: `{ from, to, from_display_name }` |

When `retired_default` is present, the default model has been redirected to `to`, and open sessions still bound to `from` have also been switched to `to`. `from_display_name` is the dropped model's display name, for use in notices.

- `40001`: malformed or unsupported action suffix in the path
- `40412`: provider not found

### `POST /api/v1/providers:refresh`

Refreshes the model metadata of every provider. The request body is optional, and its content is ignored.

On success, `data` is a refresh report with the same structure as [`POST /api/v1/providers/{provider_id}:refresh`](#post-api-v1-providers-provider-id-refresh), and it can also carry `retired_default`.

### `POST /api/v1/providers:refresh_oauth`

Refreshes only the model list of the managed provider `managed:kimi-code`. When that provider does not exist or is not OAuth-managed, nothing is refreshed and an empty report is returned. The request body is optional, and its content is ignored.

On success, `data` is a refresh report with only `changed` / `unchanged` / `failed`, without `retired_default`.

### `POST /api/v1/providers:import_catalog`

Imports one models.dev directory entry as a configured provider. On success, the reply is HTTP 201 with the standard envelope. The wire protocol and endpoint come from the catalog resolution, and every model in the entry is written as an alias.

Importing an id that already exists is a refresh: the provider entry and its aliases are rewritten from the catalog, and an omitted `api_key` keeps the stored key. This endpoint does not modify existing global default pointers. Only when no default model is configured at all is `default_model` seeded with the first imported model.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `catalog_id` | body | string | Required. Directory entry id from `GET /api/v1/catalog/providers` |
| `id` | body | string | Local provider id, overriding the catalog id. Same id rules as `POST /api/v1/providers` |
| `api_key` | body | string | API key for the imported provider |
| `base_url` | body | string | Overrides the catalog-resolved endpoint. Required when the entry's `needs_base_url` is `true` |

On success, `data` is `{ provider, models_imported }`: `provider` is the provider item, and `models_imported` is the number of aliases written.

- `40001`: `catalog_id` is missing, or another body validation failed
- `40003`: the target provider already exists and is OAuth-managed
- `40004`: the entry cannot be imported (it is rejected, requires a `base_url`, has no importable models, or its id cannot be used as a provider id)
- `40417`: no directory entry with that `catalog_id`
- `50004`: the models.dev directory is unavailable

### `POST /api/v1/providers:import_registry`

Imports a models.dev-shaped private registry (an `api.json` URL plus an optional Bearer key) as configured providers. On success, the reply is HTTP 201 with the standard envelope. Every provider the registry lists is written with a `source` record, so scheduled refreshes can rediscover it.

Re-importing the same URL removes providers that have disappeared upstream. The URL is the registry's stable identity, so rotating the key is safe. Global default pointers follow the same rules as [`:import_catalog`](#post-api-v1-providers-import-catalog).

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `url` | body | string | Required. URL of the registry's `api.json` |
| `api_key` | body | string | Bearer key for the registry. When omitted, the key from the previous import of the same URL is reused |

On success, `data` has these fields:

| Field | Type | Description |
| --- | --- | --- |
| `providers` | array | Imported provider items |
| `models_imported` | integer | Total number of aliases written |
| `credential_env` | object | Map of provider id → environment variable name. When the registry declares API key environment variables for a provider, this is the first non-empty variable name among them |

- `40001`: `url` is missing, or another body validation failed
- `40003`: a listed provider already exists and is OAuth-managed
- `40005`: the registry cannot be fetched or parsed, or lists no importable providers

### `GET /api/v1/catalog/providers`

Browses the models.dev directory. The server proxies the request with a 10-minute in-memory cache and falls back to a built-in snapshot. Entries keep the upstream directory order.

Entries the server cannot import carry `rejected: true` and a machine-readable `reject_reason`. Entries with `needs_base_url: true` require a base URL at import time.

On success, `data.items` is an array of directory entries:

| Field | Type | Description |
| --- | --- | --- |
| `id` | string | Directory entry id |
| `name` | string | Entry name |
| `wire_type` | string \| null | Resolved protocol, same enum as a provider `type` |
| `base_url` | string \| null | Resolved endpoint. `null` for entries whose `needs_base_url` is `true` or that are rejected |
| `guessed` | boolean | Whether the resolution is heuristic |
| `needs_base_url` | boolean | Whether a base URL is required at import time |
| `rejected` | boolean | Whether the server cannot import this entry |
| `reject_reason` | string \| null | Machine-readable rejection reason |
| `env_key` | string \| null | The upstream's conventional API key environment variable |
| `models` | array | Each item is `{ id, name?, max_context_size, capabilities?, reasoning }` |

- `50004`: the directory is unavailable (both the live fetch and the built-in snapshot failed)

### `GET /api/v1/catalog/providers/{catalog_id}`

Reads one models.dev directory entry by catalog id.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `catalog_id` | path | string | Required. Directory entry id |

On success, `data` is the directory entry, in the same shape as a `GET /api/v1/catalog/providers` item.

- `40417`: no directory entry with that `catalog_id`
- `50004`: the directory is unavailable

## Skills, tools, and MCP

These endpoints show the skill catalog a workspace sees and the tool list of the effective agent. For MCP server registry CRUD, connection probes, and OAuth, see [MCP management](#mcp-management). For the per-session skill catalog and skill activation (the REST equivalent of the `/<skill>` slash command), see [Session skills](#session-skills).

| Method and path | Description |
| --- | --- |
| `GET /api/v1/workspaces/{workspace_id}/skills` | Session-less skill catalog for a workspace |
| `GET /api/v1/tools` | List tools of the effective agent |
| `/api/v1/mcp/*` | MCP server registry CRUD, connection probes, and OAuth; see [MCP management](#mcp-management) |

### `GET /api/v1/workspaces/{workspace_id}/skills`

Lists the skill catalog that a session in this workspace would see, without creating or resuming a session. The catalog is computed for the workspace's primary directory and extra source folders, and merges the same sources as a session: built-in, plugin, extra, user, and project.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `workspace_id` | path | string | Required. Registered workspace id |

On success, `data` is `{ skills }`. Each item is a skill descriptor, in the same shape returned by [Session skills](#session-skills):

| Field | Type | Description |
| --- | --- | --- |
| `name` | string | Skill name. Same-name skills can be returned as multiple variants with distinct `path` values |
| `description` | string | Skill description |
| `path` | string | Path of the skill |
| `source` | string | `project` / `user` / `extra` / `builtin` |
| `workspace_dir` | string | Root directory of a project skill; omitted for other sources |
| `type` | string | Optional. Skill category; only user-activatable types can be activated |
| `disable_model_invocation` | boolean | Optional. When `true`, the skill is hidden from the model |
| `scopes` | string[] | Optional. Clients the skill declares it applies to: `tui` / `web` |

- `40410`: workspace not found

### `GET /api/v1/tools`

Lists the tools of the effective agent. The effective agent is the main agent of the selected session, and the session is picked in one of two ways:

- **`session_id` passed**: the server resumes that session on demand, loading a cold session into this server process as well. When the session does not exist, the list is empty.
- **`session_id` omitted**: the most recently created session is used, but it is not resumed. When that session is not live in this server process, the list is empty; there is no fallback to an older live session.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `session_id` | query | string | Session whose main agent to inspect. Default the most recently created session |

On success, `data` is `{ tools }`, each item with these fields:

| Field | Type | Description |
| --- | --- | --- |
| `name` | string | Tool name |
| `description` | string | Tool description |
| `input_schema` | null | Currently always `null` |
| `source` | string | `builtin` / `skill` / `mcp` |
| `mcp_server_id` | string | Present only on MCP tools, parsed from the `mcp__<server>__<tool>` tool name |
| `active` | boolean | Optional. The tool policy's verdict |

## Capabilities and plugins

These endpoints query the readiness of built-in capabilities and install them, and manage the full plugin lifecycle from marketplace browsing and installation to removal.

Capabilities are built-in features made of detection steps and a background install, with graded readiness (see `state` in [Capability status object](#capability-status-object)). The current build registers `kimi-cu` (Kimi Computer Use) and `kimi-webbridge` (Kimi Browser Extension). Plugins are installed bundles of skills, MCP servers, hooks, and commands.

| Method and path | Description |
| --- | --- |
| `GET /api/v1/capabilities` | List built-in capabilities with their readiness status |
| `GET /api/v1/capabilities/{capability_id}` | Read one capability's status |
| `POST /api/v1/capabilities/{capability_id}:install` | Start a capability install (runs in the background; poll GET for progress) |
| `GET /api/v1/plugins` | List installed plugins |
| `GET /api/v1/plugins/{plugin_id}` | Read an installed plugin and its declared capabilities |
| `POST /api/v1/plugins` | Install a custom plugin, or a marketplace entry at an expected version |
| `POST /api/v1/plugins/preview` | Inspect a marketplace entry's capabilities read-only, without installing it |
| `GET /api/v1/plugins/marketplace` | Plugin marketplace catalog merged with live install state |
| `POST /api/v1/plugins/{plugin_id}:enable` | Enable a plugin |
| `POST /api/v1/plugins/{plugin_id}:disable` | Disable a plugin |
| `POST /api/v1/plugins/{plugin_id}:remove` | Remove a plugin |

### Capability status object

Every capability endpoint returns this structure.

| Field | Type | Description |
| --- | --- | --- |
| `id` | string | Capability id |
| `plugin_id` | string | Optional. Plugin id |
| `display_name` | string | Display name |
| `description` | string | Description |
| `supported` | boolean | Whether the current platform is supported |
| `state` | string | `ready` (every required detection step is `ok`) / `partial` (some steps are `ok`) / `not_installed` / `unsupported` (not available on the current platform / architecture) |
| `version` | string | Optional. Version |
| `steps` | array | Detection steps, each `{ id, state, detail?, optional? }`, where `state` is `ok` / `missing` / `failed` |
| `install.running` | boolean | Whether an install is running |
| `install.step` | string | Optional. Current install step |
| `install.percent` | number | Optional. Install progress, from 0 to 100 |
| `install.error` | string | Optional. Install error |
| `install.note` | string | Optional. Install note |
| `install.confirmation_required` | string | Optional. When `stop-processes`, the install stopped because related processes are still running; after the user confirms, install again with `stop_running_processes: true` |

### `GET /api/v1/capabilities`

Lists every registered capability with its readiness status.

On success, `data` is `{ capabilities }`, where each item is a [capability status object](#capability-status-object).

### `GET /api/v1/capabilities/{capability_id}`

Reads one capability's readiness status. After starting an install, clients poll this endpoint for progress.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `capability_id` | path | string | Required. Capability id |

On success, `data` is a [capability status object](#capability-status-object).

- `40418`: no capability with that id

### `POST /api/v1/capabilities/{capability_id}:install`

Starts installing a capability in the background and immediately returns the current status (with `install.running` set to `true`). Clients poll [`GET /api/v1/capabilities/{capability_id}`](#get-api-v1-capabilities-capability-id) for progress.

The server dispatches through the route `POST /api/v1/capabilities/{tail}`, and `install` is the only action. A bare id or an unknown action returns `40001`.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `capability_id` | path | string | Required. Capability id |
| `stop_running_processes` | body | boolean | Optional. When `true`, the install may stop related processes that are still running. The request body may be omitted |

On success, `data` is a [capability status object](#capability-status-object).

Currently only `kimi-cu` on Windows checks for running processes. When related processes exist and `stop_running_processes: true` was not passed, the background install ends with `install.confirmation_required` set to `stop-processes`.

- `40001`: missing or unknown action suffix
- `40418`: no capability with that id
- `40924`: an install of this capability is already running
- `40925`: the capability is not supported on the current platform / architecture

### Plugin summary

Listing and installing plugins return this structure. Plugin details add fields on top of it.

| Field | Type | Description |
| --- | --- | --- |
| `id` | string | Plugin id |
| `display_name` | string | Display name |
| `description` | string | Optional. Description |
| `short_description` | string | Optional. Short description |
| `long_description` | string | Optional. Long description |
| `version` | string | Optional. Version |
| `enabled` | boolean | Whether the plugin is enabled |
| `state` | string | `ok` / `error`. A load failure also sets `has_errors` |
| `skill_count` | integer | Number of skills |
| `mcp_server_count` | integer | Number of MCP servers |
| `enabled_mcp_server_count` | integer | Number of enabled MCP servers |
| `hook_count` | integer | Number of hooks |
| `command_count` | integer | Number of commands |
| `has_errors` | boolean | Whether there are errors |
| `source` | string | `local-path` / `zip-url` / `github` |
| `original_source` | string | Optional. Original source |
| `github` | object | Optional. GitHub-sourced plugins carry the provenance `{ owner, repo, ref, installed_sha? }`, where `ref` is `{ kind, value }` and `kind` is `branch` / `tag` / `sha` |
| `origin` | string | `marketplace` / `custom` / `unknown` |
| `catalog_id` | string | Optional. Catalog id |
| `installed_at` | string | Install time, ISO timestamp |

### `GET /api/v1/plugins`

Lists installed plugins.

On success, `data` is `{ plugins }`, where each item is a [plugin summary](#plugin-summary).

### `GET /api/v1/plugins/{plugin_id}`

Reads an installed plugin's details and capabilities. Both the `skills` and `mcp_servers` lists come from the plugin's actual files and manifest. `interface.skillOverrides` and `interface.mcpOverrides` in the manifest override display information only; they do not change invocation names or runtime configuration.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `plugin_id` | path | string | Required. Installed plugin id |
| `locale` | query | string | Optional. For example `en-US` or `zh-CN`. Selects the matching translation from `interface.locales` and affects only the display text of capabilities; fields without a match fall back to the default `interface` |

On success, `data` is a [plugin summary](#plugin-summary) plus these fields:

| Field | Type | Description |
| --- | --- | --- |
| `root` | string | Plugin root directory |
| `updated_at` | string | Optional. Update time |
| `manifest_kind` | string | Optional. Manifest kind: `kimi-plugin-root` / `kimi-plugin-dir` |
| `manifest_path` | string | Optional. Manifest path |
| `skills` | array | Skills actually discovered: the invocation name `name`, plus the optional display name `display_name` and description `description` |
| `mcp_servers` | array | MCP servers declared in the manifest: `name`, `runtime_name`, `enabled`, `transport`, non-secret connection settings (`command`, `args`, `cwd`, `url`, `env_keys`, `header_keys`), and optional `display_name`, `description`, and `icon_url` |
| `shadowed_manifest_path` | string | Optional. Path of the shadowed manifest |
| `diagnostics` | array | Diagnostics, each `{ severity, message }`, where `severity` is `error` / `warn` / `info` |

- `40419`: no installed plugin with that id

### `POST /api/v1/plugins`

Installs a plugin and returns its summary. The request body takes one of two forms: a custom install passes only `source`; a marketplace install passes `marketplace_id` plus the expected version information, and does not pass `source` directly. Neither form accepts other fields.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `source` | body | string | Required for a custom install. An absolute local path, an http(s) ZIP URL, or a GitHub URL. A GitHub URL can pin a version with `/tree/<branch-or-sha>`, `/releases/tag/<tag>`, or `/commit/<sha>` |
| `marketplace_id` | body | string | Required for a marketplace install. Catalog entry id |
| `expected_version` | body | string | For marketplace installs. The version shown to the user; custom entries without a version may omit it |
| `expected_sha256` | body | string | For marketplace installs. The `sha256sum` shown to the user (64 hex characters). When a ZIP entry declares `sha256sum`, it must be passed and must match the catalog; local-directory and GitHub entries do not need it |

For a marketplace install, the server resolves `source`, `sha256sum`, and the expected plugin ID from the same catalog snapshot, verifies the archive before extraction, and checks the manifest ID.

On success, `data` is a [plugin summary](#plugin-summary).

- `40001`: validation failed, for example `source` is neither a URL nor an absolute path, or the plugin failed to load
- `40409`: the local path does not exist
- `40419`: no marketplace entry with that id
- `40934`: the catalog entry has changed since the version shown to the user (refresh the catalog and retry)

### `POST /api/v1/plugins/preview`

Inspects a marketplace entry's capabilities read-only, without installing the plugin. The server downloads the archive into a temporary directory, verifies its SHA-256 before extraction, checks the manifest ID, and discovers the skills and MCP servers inside. A preview writes no install record, installs no runtime, and does not keep the extracted plugin.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `marketplace_id` | body | string | Required. Catalog entry id |
| `expected_version` | body | string | The version shown to the user |
| `expected_sha256` | body | string | Optional. The `sha256sum` shown to the user (64 hex characters); when given, it must match the current catalog |
| `locale` | body | string | Optional. Language of the display text, selected by the same rules as `locale` in [`GET /api/v1/plugins/{plugin_id}`](#get-api-v1-plugins-plugin-id) |

On success, `data` is `{ skills, mcp_servers }`, for example:

```json
{
  "skills": [{ "name": "<skill name>", "description": "<optional description>" }],
  "mcp_servers": [{ "name": "<name in manifest>", "runtime_name": "<runtime name>", "enabled": true, "transport": "stdio" }]
}
```

Both entry types can also include `display_name` and `description` from overrides, and MCP entries can also include `icon_url`. MCP entries use the same field structure as [`GET /api/v1/plugins/{plugin_id}`](#get-api-v1-plugins-plugin-id); the example lists only the common fields.

- `40001`: the request, archive, SHA-256, or manifest is invalid
- `40419`: no marketplace entry with that id
- `40934`: the catalog entry has changed since the version shown to the user (refresh the catalog and retry)

### `GET /api/v1/plugins/marketplace`

Lists the plugin marketplace catalog merged with live install state. The default catalog URL is derived from the current managed `baseURL` as `${baseURL}/plugins/marketplace`, and built-in capability entries are no longer injected.

The server filters entries by two conditions, and an entry must meet both:

- **Host**: the catalog's `clients` limits an entry to `desktop`, `cli`, or both; when omitted, both hosts can use it. Web and Remote Control use the host identity of the connected server.
- **Operating system**: `platforms` filters independently by the operating system the server runs on. An entry is kept when `platforms` is unset, includes the server's platform, or contains only `cloud`. Other entries are filtered out, including entries that list `cloud` together with other platforms but not the server's platform.

Cloud-only entries cannot be installed locally. The legacy `kimi-webbridge` entry is no longer returned, and Computer Use returns only the wiring plugin for the current platform.

Install records and managed files are still shared under the server's data directory. Entries unavailable to the current host are also hidden from that host's installed list and runtime capabilities.

The server caches the last successfully fetched availability configuration in `plugins/availability.json`. After a successful catalog refresh, changed client rules hide or restore existing installs without reinstalling them or deleting plugin files.

On success, `data` is `{ entries }`, each item with the fields below. For the request form of a marketplace install, see [`POST /api/v1/plugins`](#post-api-v1-plugins).

| Field | Type | Description |
| --- | --- | --- |
| `id` | string | Catalog entry id, passed as `marketplace_id` for a marketplace install |
| `tier` | string | Entry tier: `official` / `curated` / `third-party`. When the entry declares `distribution`, it is `official` if `distribution.category` is `official`, otherwise `curated`; without `distribution`, it is the entry's `tier`, defaulting to `third-party` |
| `classification` | string | Entry classification: `official` / `third_party`. When the entry declares `distribution`, it is `distribution.category`; otherwise it is derived from `tier`: `official` gives `official`, anything else gives `third_party` |
| `display_name` | string | Display name |
| `description` | string | Optional. Description, in the language declared by `default_locale` |
| `short_description` | string | Optional. Short description |
| `long_description` | string | Optional. Long description |
| `cli_description` | string | Optional. CLI description, in the language declared by `default_locale` |
| `homepage` | string | Optional. Homepage |
| `keywords` | string[] | Optional. Keywords |
| `version` | string | Optional. Version |
| `source` | string | Entry source |
| `icon_url` | string | Optional. Icon URL |
| `sha256sum` | string | Optional. Archive digest |
| `filename` | string | Optional. File name |
| `locale` | object | Optional. Per-language translations of `display_name`, `short_description`, `long_description`, and `cli_description` (plus `default_locale`) |
| `default_locale` | string | Optional. Language of the top-level `description` / `cli_description` |
| `platforms` | string[] | Optional. `darwin` / `win32` / `linux` / `cloud` |
| `distribution` | object | Optional. Distribution info: `category` is `official` / `third_party`; optional `region` (string), `default_install` (boolean), `weight` (number), and `user_level` |
| `billing` | object | Optional. Billing info, taken as-is from the catalog |
| `installed` | object | Optional. Present when installed, with the live install state `{ version?, enabled }` |
| `update_available` | boolean | Optional. `true` when an update is available, otherwise omitted |
| `capability_id` | string | Optional. Set only by the server, and only when the default marketplace is used: `kimi-browser-extension` maps to the `kimi-webbridge` capability, and `kimi-cu` / `kimi-cu-win` map to the `kimi-cu` capability |

- `50001`: the marketplace is unreachable or returned an invalid catalog

### `POST /api/v1/plugins/{plugin_id}:enable`

Enables an installed plugin. Plugin actions dispatch through one route, `POST /api/v1/plugins/{tail}`: the tail is parsed as `{plugin_id}:{action}`, with `enable` / `disable` / `remove` as the actions. A bare id or an unknown action returns `40001` (`unsupported action: ...`).

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `plugin_id` | path | string | Required. Installed plugin id |

On success, `data` is `{ ok: true }`.

- `40001`: missing or unknown action suffix
- `40419`: no installed plugin with that id

### `POST /api/v1/plugins/{plugin_id}:disable`

Disables an installed plugin without removing it. Dispatch works as in [`:enable`](#post-api-v1-plugins-plugin-id-enable).

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `plugin_id` | path | string | Required. Installed plugin id |

On success, `data` is `{ ok: true }`.

- `40001`: missing or unknown action suffix
- `40419`: no installed plugin with that id

### `POST /api/v1/plugins/{plugin_id}:remove`

Removes an installed plugin. Dispatch works as in [`:enable`](#post-api-v1-plugins-plugin-id-enable).

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `plugin_id` | path | string | Required. Installed plugin id |

On success, `data` is `{ ok: true }`.

- `40001`: missing or unknown action suffix
- `40419`: no installed plugin with that id

## Workspaces

These endpoints manage the workspace registry and read and write each workspace's trust state. A workspace is a registered project directory that sessions live in; the trust state decides whether the workspace's project-level MCP config loads. Endpoints that return a workspace use the [workspace object](#workspace-object).

| Method and path | Description |
| --- | --- |
| `GET /api/v1/workspaces` | List registered workspaces |
| `POST /api/v1/workspaces` | Register a workspace (each call creates a new entry; retries are deduplicated with `idempotency_key`) |
| `PATCH /api/v1/workspaces/{workspace_id}` | Rename, or replace the source folders as a whole |
| `POST /api/v1/workspaces/{workspace_id}/primary` | Promote a source folder to the primary directory |
| `GET /api/v1/workspaces/project-config-dirs` | Read the additional directories in a project's `local.toml`, read-only |
| `DELETE /api/v1/workspaces/{workspace_id}` | Unregister a workspace (keeps on-disk content) |
| `GET /api/v1/workspaces/{workspace_id}/trust` | Read the trust state |
| `POST /api/v1/workspaces/{workspace_id}/trust` | Grant trust |
| `POST /api/v1/workspaces/{workspace_id}/untrust` | Revoke trust |

### Workspace object

When a workspace is registered or updated, the server broadcasts the [global event](#global-events) `workspace` with `change: "created"` or `"updated"` and the full workspace object.

| Field | Type | Description |
| --- | --- | --- |
| `id` | string | Workspace id. `wd_<slug>_<hash12>` for implicit channels (CLI / VS Code entering a directory), `wm_<uuid>` when created explicitly through `POST /api/v1/workspaces` |
| `root` | string | Absolute path of the primary directory |
| `name` | string | Display name, 1–100 characters; defaults to the base name of the primary directory |
| `kind` | string | `managed`: created explicitly, `wm_` id; sessions do not merge the project `local.toml`. `implicit`: registered implicitly by directory, `wd_` id; sessions merge the project `local.toml` for compatibility with legacy config |
| `additional_dirs` | string[] | Absolute paths of the registry-managed extra source folders, excluding the project `local.toml` and ephemeral sources |
| `created_at` | string | Registration time, ISO 8601 |
| `last_opened_at` | string | Last time the workspace was opened or re-registered, ISO 8601 |
| `session_count` | integer | Number of sessions in the workspace |

### `GET /api/v1/workspaces`

Lists every registered workspace.

On success, `data` is `{ items }`, where each item is a [workspace object](#workspace-object).

### `POST /api/v1/workspaces`

Registers a new workspace and returns it. Every call creates a new entry (`wm_<uuid>` id). Even when the same path is already another workspace's primary directory, the call does not merge into the existing entry or warn.

When a client resubmits (network retry, double click), it should send the same `idempotency_key`. The server deduplicates by key and returns the entry created the first time.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `root` | body | string | Required. Absolute path of an existing directory, used as the primary directory |
| `name` | body | string | Display name, 1–100 characters. Default the base name of the primary directory |
| `additional_dirs` | body | string[] | Extra source folders, at most 64 items. Each item resolves by the `add-dir` rules (absolute path, relative to the primary directory, or `~` expansion), must exist and be a directory, and must not duplicate the primary directory or another item |
| `idempotency_key` | body | string | Client-generated idempotency key, 1–200 characters. Retries with the same key return the workspace created the first time |

On success, `data` is a [workspace object](#workspace-object).

- `40001`: `root` is missing or not an absolute path, or another request validation failed (`details` lists the field)
- `40006`: `additional_dirs` contains duplicates or the primary directory itself. `msg` is `Duplicate source folder: <actual path>`; `details` is `[{ "path": "additional_dirs.N", "directory": "<resolved absolute path>" }]`, where `path` is the location of the request field and `directory` is the duplicated directory
- `40409`: `root` or a path in `additional_dirs` does not exist or is not a directory

### `PATCH /api/v1/workspaces/{workspace_id}`

Updates a workspace's display name and/or source folders; the primary directory cannot be changed. At least one of `name` and `additional_dirs` is required. `additional_dirs` is a whole-list replacement: submit the full edited list, or omit the field to keep it unchanged.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `workspace_id` | path | string | Required. Workspace id |
| `name` | body | string | New display name, 1–100 characters |
| `additional_dirs` | body | string[] | Full replacement list of extra source folders, resolved and validated as in [`POST /api/v1/workspaces`](#post-api-v1-workspaces) |

On success, `data` is a [workspace object](#workspace-object).

- `40001`: both fields are missing, or another request validation failed (`details` explains each field)
- `40006`: duplicate entries, or an entry equal to the primary directory; `msg`, `details.path`, and `details.directory` mean the same as in [`POST /api/v1/workspaces`](#post-api-v1-workspaces)
- `40409`: a path in `additional_dirs` does not exist or is not a directory
- `40410`: workspace not found

### `POST /api/v1/workspaces/{workspace_id}/primary`

Promotes a source folder in the directory set to the primary directory. The server performs an atomic swap: the path becomes the new `root`, and the previous primary directory moves into `additional_dirs`. The workspace id and session bucket do not change, and all sessions are kept. `local.toml` follows the primary directory, so after the swap the additional directories in the previous primary directory's `local.toml` are no longer merged.

For existing sessions that run on the `local` environment without an explicit `environmentCwd`, the default working directory and relative paths of later tool calls follow the new primary directory. An explicit `environmentCwd` and remote environment bindings keep their configured directory.

Additional directories only widen the allowed access scope; they are not candidate roots for relative paths, so access them with absolute paths or an explicit `cwd`. Registered tools stay available during the swap, and the workspace's existing trust decision is kept across restarts.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `workspace_id` | path | string | Required. Workspace id |
| `path` | body | string | Required. Directory to promote, resolved by the `add-dir` rules; must be in the current directory set (`root` ∪ `additional_dirs`) |

On success, `data` is a [workspace object](#workspace-object).

- `40001`: `path` is not in the directory set
- `40409`: `path` does not exist or is not a directory
- `40410`: workspace not found

### `GET /api/v1/workspaces/project-config-dirs`

Returns `workspace.additional_dir` from the given project's `local.toml`, read-only. The result is resolved to absolute paths, deduplicated, and excludes `root` itself. The endpoint modifies neither the registry nor `local.toml`. Clients can use it to merge a project's legacy config into the create or edit workspace form, taking effect on save.

The server walks up from `root` to the first directory that contains `.git` and uses it as the project root (or `root` itself when none is found), then reads `.kimi-code/local.toml` there. A missing `local.toml` returns an empty array. Malformed TOML or a configured directory that no longer exists fails the request instead of returning an empty config.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `root` | query | string | Required. Absolute path of the project's primary directory |

On success, `data` is `{ additional_dirs: string[] }`.

- `40001`: `root` is missing or empty; the structure of `local.toml` is invalid (for example `workspace.additional_dir` is not an array of strings); or a directory configured there does not exist or is not a directory
- `50001`: `local.toml` is not valid TOML, or reading it failed

### `DELETE /api/v1/workspaces/{workspace_id}`

Unregisters a workspace. Only the registry entry is removed; the directory on disk is untouched.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `workspace_id` | path | string | Required. Workspace id |

On success, `data` is `{ deleted: true }`.

- `40410`: workspace not found

### `GET /api/v1/workspaces/{workspace_id}/trust`

Reads the workspace's trust state. The trust state decides whether project-level MCP config loads for the workspace.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `workspace_id` | path | string | Required. Workspace id |

On success, `data` is `{ trusted }`.

- `40410`: workspace not found

### `POST /api/v1/workspaces/{workspace_id}/trust`

Marks the workspace as trusted and loads its project-level MCP config.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `workspace_id` | path | string | Required. Workspace id |

On success, `data` is `{ trusted: true }`.

- `40410`: workspace not found

### `POST /api/v1/workspaces/{workspace_id}/untrust`

Revokes the persisted trust records associated with the current directory set. Unless a process or config override keeps the workspace trusted, its project-level MCP config is also unloaded.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `workspace_id` | path | string | Required. Workspace id |

On success, `data` is `{ trusted }`, the effective trust state after revocation. It is normally `false`, but stays `true` when `KIMI_CODE_TRUST_WORKSPACE` or [`[workspace] require_trust = false`](https://moonshotai.github.io/kimi-code/en/configuration/config-files.html#workspace-trust) applies.

- `40410`: workspace not found

## File uploads

These endpoints upload files for later reference (for example as prompt attachments), and download or delete uploaded files.

| Method and path | Description |
| --- | --- |
| `POST /api/v1/files` | Multipart upload (`file` field, optional `name` and `expires_in_sec`); returns file metadata |
| `GET /api/v1/files/{file_id}` | Download (binary; errors use real HTTP status codes) |
| `DELETE /api/v1/files/{file_id}` | Delete |

### `POST /api/v1/files`

Uploads a file as `multipart/form-data`.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `file` | body | binary | Required. The multipart file part |
| `name` | body | string | Stored display name. Default the uploaded file name |
| `expires_in_sec` | body | number | Seconds until the file expires (non-negative). Default never expires |

On success, `data` is the file metadata:

| Field | Type | Description |
| --- | --- | --- |
| `id` | string | File id, used to download and delete the file |
| `name` | string | Display name |
| `media_type` | string | Taken from the upload's content type |
| `size` | integer | File size |
| `created_at` | string | Upload time |
| `expires_at` | string | Optional. Expiry time |

- `40001`: the multipart body has no `file` field

### `GET /api/v1/files/{file_id}`

Downloads an uploaded file. The response is a binary stream that supports range requests but does not handle `If-None-Match`. Failures use real HTTP status codes; see [Binary and streaming endpoints](#binary-and-streaming-endpoints).

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `file_id` | path | string | Required. File id from the upload response |

- `40407` (HTTP 404): no file with that id (including an expired file)

### `DELETE /api/v1/files/{file_id}`

Deletes an uploaded file.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `file_id` | path | string | Required. File id from the upload response |

On success, `data` is `{ deleted: true }`.

- `40407` (HTTP 404): no file with that id

## Global search

Cross-session full-text search endpoint.

| Method and path | Description |
| --- | --- |
| `POST /api/v1/search` | Cross-session full-text search; `mode` is `terms` (default) or `literal` (exact substring); paginated with `page_token` |

### `POST /api/v1/search`

Cross-session full-text search over user messages, assistant replies, and session titles, backed by the server's persistent search index.

A search scoped to one session with `container.session_id` also uses the index. So text that a running step is still generating becomes searchable only after the step is saved and the index catches up; a view that is still catching up is marked by `index_state.stale`.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `query` | body | string | Required. Search text |
| `mode` | body | string | `terms` (default) / `literal` |
| `op` | body | string | How terms combine in `terms` mode: `AND` (default) / `OR` |
| `container` | body | object | Restrict the search to `{ session_id?, agent_id? }` |
| `role` | body | string | Only `user` / `assistant` / `title` hits |
| `start_time` | body | integer | Only hits at or after this time (epoch milliseconds) |
| `end_time` | body | integer | Only hits at or before this time (epoch milliseconds) |
| `sort` | body | string | `score` (default) / `time_desc` / `time_asc`; `literal` mode ignores it and always returns newest first |
| `page_size` | body | integer | Hits per page, 1–50. Default `20` |
| `page_token` | body | string | Token returned by the previous page's response |

`terms` mode tokenizes the query (ASCII words plus CJK n-grams), deduplicates the terms, and matches at most 32 terms against the inverted index. `literal` mode is an exact substring search with zero false positives.

Page tokens pin the index generation and the query conditions, so an index rebuild or a changed query invalidates them.

On success, `data` has these fields:

| Field | Type | Description |
| --- | --- | --- |
| `items` | array | Hits; item fields in the table below |
| `has_more` | boolean | Whether there is a next page |
| `page_token` | string | Optional. Token for the next page |
| `incomplete` | string | Present only on over-budget pages: `candidate_cap` / `postings_budget` / `deadline` |
| `index_state.state` | string | `building` / `ready` / `readonly` |
| `index_state.indexed_sessions` | integer | Number of indexed sessions |
| `index_state.total_sessions` | integer | Total number of sessions |
| `index_state.documents` | integer | Number of documents |
| `index_state.stale` | boolean | Optional. Marks a lagging view that is still catching up |
| `index_state.degraded` | string | Optional. Message of the most recent refresh failure |

Fields of each `items` entry:

| Field | Type | Description |
| --- | --- | --- |
| `session_id` | string | Session id |
| `workspace_id` | string | Workspace id |
| `session_title` | string | Session title |
| `agent_id` | string | Agent id |
| `role` | string | `user` / `assistant` / `title` |
| `snippet` | string | Matched snippet |
| `time` | number | Hit time |
| `turn` | integer | Optional. Turn |
| `step_id` | string | Optional. Step id |
| `score` | number | Relevance score |

- `40001`: body validation failed, the query is unusable (empty, or more than 32 terms), or the page token is invalid

## MCP management

`/api/v1/mcp/*` is the server's unified MCP management plane. It is independent of any session and manages the MCP server registry itself. It covers CRUD on user-level config (each entry is validated before it is written), connection tests, a locator-addressed inspection catalog, per-server auth status, and the full OAuth flow.

| Method and path | Description |
| --- | --- |
| `GET /api/v1/mcp/servers` | List every known MCP server |
| `GET /api/v1/mcp/servers/{name}` | Get one MCP server by runtime name |
| `POST /api/v1/mcp/servers` | Add an MCP server to the user-level `mcp.json` |
| `PUT /api/v1/mcp/servers/{name}` | Replace a user-level entry |
| `DELETE /api/v1/mcp/servers/{name}` | Delete a user-level entry |
| `POST /api/v1/mcp/servers:test` | Probe a real connection to one MCP server |
| `POST /api/v1/mcp/servers:inspect` | Locator-addressed catalog with batched connection probes |
| `GET /api/v1/mcp/auth-statuses` | OAuth state of each MCP server in the catalog |
| `POST /api/v1/mcp/auth:begin` | Begin an interactive OAuth flow |
| `POST /api/v1/mcp/auth:complete` | Wait for the browser callback and finish the code exchange |
| `POST /api/v1/mcp/auth:cancel` | Terminate a begun OAuth flow |
| `POST /api/v1/mcp/auth:reset` | Clear an MCP server's stored credentials |

The management plane uses two addressing schemes:

- **Runtime name**: the CRUD endpoints and `servers:test` use a plain runtime `name`.
- **Locator**: the inspection and OAuth endpoints use a locator, because a plugin entry and a file entry can share one runtime name. A file-layer entry's locator is `{ "source": "global", "name" }`, and a plugin-manifest entry's is `{ "source": "plugin", "plugin_id", "server_name" }`.

Inspection results also carry a stable `server_id`: `global:<name>` or `plugin:<plugin_id>:<server_name>` (URL-encoded).

Every endpoint except `auth:complete` and `auth:cancel` accepts an optional `cwd`: in the request body for `servers:test` and `servers:inspect`, and as a query parameter for the rest (including `auth:begin` and `auth:reset`). Without it, the catalog covers only the user-level file and plugin manifests. With it, the project-root and project-local layers of that directory join in, but only when the workspace is [trusted](#get-api-v1-workspaces-workspace-id-trust); otherwise the project layers are skipped. For `servers:test` on a stdio server, `cwd` is also the child process's working directory.

Connection probes and OAuth calls wait until the server configuration has finished loading.

### `GET /api/v1/mcp/servers`

Lists every MCP server the management plane knows about.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `cwd` | query | string | Include the project layers of this directory (must be trusted) |

On success, `data` is an array of managed MCP servers, each with these fields:

| Field | Type | Description |
| --- | --- | --- |
| `name` | string | Runtime name |
| `config` | object | Mutable entries carry the full config (common fields `enabled`, `deferred`, `startup_timeout_ms`, `tool_timeout_ms`, `enabled_tools`, `disabled_tools`; `stdio` adds `command`, `args`, `env`, `cwd`, `executor`, `environment_id`; `http` / `sse` add `url`, `headers`, `auth`, `bearer_token_env_var`) so edit UIs can prefill it; read-only entries are redacted to sorted key lists (`env_keys` / `header_keys`) and never disclose secret values |
| `source` | string | `global` (a config-file layer, including the user-level file and project layers) or `plugin` (a plugin manifest). The schema also has `caller`, which is currently never returned |
| `origin` | string | Where the entry is defined: a file path or a plugin id |
| `mutable` | boolean | Only user-level entries are mutable; plugin and project-layer entries are read-only |
| `plugin` | object | Present only on plugin entries: `{ id, name }` |

- `40001`: validation failure

### `GET /api/v1/mcp/servers/{name}`

Gets one MCP server by runtime name.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `name` | path | string | Required. Runtime name of the MCP server |
| `cwd` | query | string | Include the project layers of this directory (must be trusted) |

On success, `data` is a single managed MCP server, with the same fields as [`GET /api/v1/mcp/servers`](#get-api-v1-mcp-servers).

- `40001`: validation failure
- `40408`: no MCP server with that name

### `POST /api/v1/mcp/servers`

Adds an MCP server to the user-level `mcp.json`. The request body is a full server config including `name`. `transport` (`stdio` / `http` / `sse`) determines the config shape, and the config is validated before it is written.

A write that collides with a same-named project-layer entry is rejected because that entry is read-only; edit the file that defines it instead. Project layers join in only when `cwd` is passed and that directory is trusted, so this collision is checked only then. A collision with a same-named plugin entry does not block the write, and the new file entry shadows the plugin entry.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `cwd` | query | string | Include the project layers of this directory (must be trusted); the returned list also includes project layers |

On success, `data` is the refreshed MCP server list, with the same fields as [`GET /api/v1/mcp/servers`](#get-api-v1-mcp-servers).

- `40001`: validation failure, or the target entry is read-only

### `PUT /api/v1/mcp/servers/{name}`

Replaces a user-level entry. The request body is the same config as in [`POST /api/v1/mcp/servers`](#post-api-v1-mcp-servers), but without `name`, because the path names the entry. Collisions with same-named entries follow the same rules.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `name` | path | string | Required. Runtime name of the entry to replace |
| `cwd` | query | string | Include the project layers of this directory (must be trusted) |

On success, `data` is the refreshed MCP server list.

- `40001`: validation failure, or the target entry is read-only
- `40408`: no MCP server with that name

### `DELETE /api/v1/mcp/servers/{name}`

Deletes a user-level entry. No request body.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `name` | path | string | Required. Runtime name of the entry to delete |
| `cwd` | query | string | Include the project layers of this directory (must be trusted) |

On success, `data` is the refreshed MCP server list.

- `40001`: validation failure, or the target entry is read-only
- `40408`: no MCP server with that name

### `POST /api/v1/mcp/servers:test`

Probes a real connection to one MCP server and persists nothing. Pass `name` to probe a registry entry (plugin and trusted project layers included), or pass `server` to probe an inline config as-is. Exactly one of the two must be passed.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `name` | body | string | Runtime name of a registry entry |
| `server` | body | object | Inline config to probe as-is; must include `name` |
| `cwd` | body | string | Used to include project layers; also the working directory of a stdio child process |

On success, `data` is `{ success, output }`: when the connection succeeds, `output` lists the server's available tools; otherwise it carries the failure message.

- `40001`: both or neither target form passed, the inline config is invalid, or the runtime name is shared by multiple enabled MCP servers
- `40408`: no MCP server with that name

### `POST /api/v1/mcp/servers:inspect`

Returns the locator-addressed catalog (with redacted configs) and runs a batched real-connection probe of every OAuth candidate. A probe that hits an expired grant may refresh or invalidate the stored credentials.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `targets` | body | array | Locators that narrow the catalog; when omitted, every MCP server is inspected |
| `cwd` | body | string | Include the project layers of this directory (must be trusted) |

On success, `data` is an array of inspection results, each with these fields:

| Field | Type | Description |
| --- | --- | --- |
| `server_id` | string | Stable identifier; format in [MCP management](#mcp-management) |
| `locator` | object | The entry's locator |
| `runtime_name` | string | Runtime name |
| `canonical_url` | string | Optional. Credential URL of a remote server |
| `origin` | string | Entry source, with the same values as `source` in [`GET /api/v1/mcp/servers`](#get-api-v1-mcp-servers) |
| `config` | object | Redacted config |
| `enabled` | boolean | Whether the entry is enabled |
| `editable` | boolean | Whether the entry is editable |
| `auth_status` | string | `not-applicable` / `bearer-token` / `oauth-required` / `oauth-authorized` / `oauth-expired` / `unavailable`. A runtime name shared by multiple enabled MCP servers cannot be probed unambiguously and reports `unavailable` |
| `checked_at` | number | Optional. Check time |
| `error` | string | Optional. Error explanation, for example when the runtime name is shared |

- `40001`: validation failure
- `40408`: a locator in `targets` matches no entry

### `GET /api/v1/mcp/auth-statuses`

Reads the OAuth state of each MCP server in the registry catalog. When only the auth dimension is needed, it is lighter than [`servers:inspect`](#post-api-v1-mcp-servers-inspect). Verification probes may refresh or invalidate stored credentials.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `cwd` | query | string | Include the project layers of this directory (must be trusted) |
| `verify` | query | string | `true`: verify every OAuth candidate through a real connection. `false`: fully offline, classifying only from config and stored tokens. Omitted: keep implicit OAuth detection, probing only unpinned remote servers without stored credentials |

On success, `data` is an array of `{ name, auth_status }`, with the same `auth_status` values as [`servers:inspect`](#post-api-v1-mcp-servers-inspect).

### `POST /api/v1/mcp/auth:begin`

Begins an interactive OAuth flow for a remote MCP server. The target must use a remote transport (`http` / `sse`) and must not carry a static bearer token; static headers are allowed only when the config explicitly sets `auth: "oauth"`.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| locator | body | object | Required. The whole request body is the target's [locator](#mcp-management) |
| `cwd` | query | string | Optional. Include the project layers of this directory (must be trusted) |

On success, `data.status` is one of two values:

| Field | Type | Description |
| --- | --- | --- |
| `status` | string | `authorization-required`: authorization is needed. `already-authorized`: a grant already exists, and no other fields are present |
| `flow_id` | string | `authorization-required` only: flow id, used by `auth:complete` and `auth:cancel` |
| `authorization_url` | string | `authorization-required` only: open this URL in a browser to grant access |

- `40001`: validation failure; the MCP server cannot use OAuth (stdio transport, a static bearer token, or static headers without `auth: "oauth"`); or the runtime name is shared by multiple enabled MCP servers
- `40408`: the locator matches no entry
- `40929`: the OAuth flow itself failed

### `POST /api/v1/mcp/auth:complete`

Waits for the browser callback of a begun flow and finishes the code exchange. The wait defaults to 15 minutes and can be overridden with `timeout_ms`; an idle flow expires after 15 minutes regardless. Closing the HTTP connection on the client side aborts the wait.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `flow_id` | body | string | Required. Flow id returned by `auth:begin` |
| `timeout_ms` | body | integer | Wait time in milliseconds, from 1 to 2³¹−1. Default 15 minutes |

On success, `data` is `null`.

- `40001`: validation failure, including an unknown `flow_id` or an out-of-range `timeout_ms`
- `40929`: the OAuth flow itself failed

### `POST /api/v1/mcp/auth:cancel`

Terminates a begun flow without finishing it. Unknown flows are ignored.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `flow_id` | body | string | Required. Id of the flow to terminate |

On success, `data` is `null`.

- `40001`: validation failure
- `40929`: the OAuth flow itself failed

### `POST /api/v1/mcp/auth:reset`

Clears an MCP server's stored credentials. The invalidation event reaches live sessions.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| locator | body | object | Required. The whole request body is the target's [locator](#mcp-management) |
| `cwd` | query | string | Optional. Include the project layers of this directory (must be trusted) |

On success, `data` is `null`.

- `40001`: validation failure; the target uses stdio transport; or the runtime name is shared by multiple enabled MCP servers
- `40408`: the locator matches no entry
- `40929`: the OAuth flow itself failed

---

# File endpoints

This section lists the server's file endpoints: the session file system, the workspace file system, the host file endpoints, and the HTTP behavior of the endpoints that return binary streams. Shared conventions such as [authentication](#authentication), the [response envelope](#response-envelope), and [error codes](#error-codes) are covered in [Overview](#kimi-agent-protocol-kap-reference-beta). The endpoints for sessions themselves are in [Session endpoints](#session-endpoints).

> **Warning:** `GET /api/v1/fs:content` can read the raw bytes of any file on the host and is gated only by the API token. Be careful when exposing the server port beyond the local machine.
## Common rules

The following conventions apply to several endpoints on this page and are not repeated under each endpoint.

- **Request form for session file operations**: in-session file operations all go through `POST /api/v1/sessions/{session_id}/fs:{action}` with a JSON body. Actions are `list` / `read` / `list_many` / `stat` / `stat_many` / `mkdir` / `search` / `grep` / `git_status` / `git_status:batch` / `pull_request` / `pull_request:batch` / `diff` / `open` / `open-in` / `reveal`.
- **Execution environment**: actions run on the environment the session was created on. `open`, `open-in`, and `reveal` only work for sessions on the `local` environment; for a session on another environment they return `50001`.
- **Common error codes for session file operations**: every `fs:{action}` endpoint may return the following error codes, which are not repeated in each endpoint's error list. For `fs:search`, `40401` has a broader meaning; see [that endpoint](#post-api-v1-sessions-session-id-fs-search).
  - `40001`: body validation failure, or the action name after `fs:` is not supported
  - `40401`: session not found
  - `40420`: the session's environment not found
  - `40926`: the session's environment is unavailable or lacks a capability the action needs. All actions need the file system capability; `search`, `grep`, `git_status`, `pull_request`, `diff`, and their batch forms also need the process execution capability
  - `40930`: the session requires a newer server to read
- **Common error codes for workspace file operations**: the three endpoints under `/api/v1/workspace/fs:*` all return `40001` (body validation failure) and `40410` (workspace not found and not a usable absolute path). These two codes are not repeated in each endpoint's error list.

### Entry object

`fs:list`, `fs:list_many`, `fs:stat`, `fs:stat_many`, `fs:mkdir`, and `POST /api/v1/workspace/fs:list` all describe a file system path with an entry object:

| Field | Type | Description |
| --- | --- | --- |
| `path` | string | Entry path |
| `name` | string | Entry name |
| `kind` | string | `file` / `directory` / `symlink`. A symlink itself is `symlink`, regardless of its target type |
| `size` | integer | File size in bytes. Present only when `kind` is `file` |
| `modified_at` | string | Modification time, in ISO 8601 format |
| `etag` | string | The entry's ETag |
| `mime` | string | MIME type. Present only when `fs:stat` returns a file entry |
| `language_id` | string | Language identifier. Present only when `fs:stat` returns a file entry and the language can be detected from the file name |
| `is_directory` | boolean | Returned only by directory-listing endpoints: `true` when the entry is a symlink to a directory, omitted otherwise. A symlink whose target is outside the workspace counts as a directory only when the request sets `allow_external_symlinks: true` |

The entry object schema also declares `is_binary`, `is_symlink_to`, `git_status`, and `child_count`. The current implementation does not return these fields.

## Session file system

List directories, read files, search, query Git status, and open files on the host, all within the session workspace.

| Method and path | Description |
| --- | --- |
| `POST /api/v1/sessions/{session_id}/fs:list` | List directory entries, optionally recursive |
| `POST /api/v1/sessions/{session_id}/fs:read` | Read a slice of a file as text or base64 |
| `POST /api/v1/sessions/{session_id}/fs:list_many` | List several directories in one call |
| `POST /api/v1/sessions/{session_id}/fs:stat` | Stat a single path |
| `POST /api/v1/sessions/{session_id}/fs:stat_many` | Stat several paths in one call |
| `POST /api/v1/sessions/{session_id}/fs:mkdir` | Create a directory |
| `POST /api/v1/sessions/{session_id}/fs:search` | Fuzzy-search files and directories by name |
| `POST /api/v1/sessions/{session_id}/fs:grep` | Search file contents |
| `POST /api/v1/sessions/{session_id}/fs:git_status` | Read Git status |
| `POST /api/v1/sessions/{session_id}/fs:git_status:batch` | Read Git status for several directories in one call |
| `POST /api/v1/sessions/{session_id}/fs:pull_request` | Read the pull request linked to a directory |
| `POST /api/v1/sessions/{session_id}/fs:pull_request:batch` | Read the pull requests linked to several directories in one call |
| `POST /api/v1/sessions/{session_id}/fs:diff` | Return the unified git diff of a single file |
| `POST /api/v1/sessions/{session_id}/fs:open` | Open a file with an editor or the default program (`local` environment only) |
| `POST /api/v1/sessions/{session_id}/fs:open-in` | Open a file or directory in a given application (`local` environment only) |
| `POST /api/v1/sessions/{session_id}/fs:reveal` | Reveal a file in the file manager (`local` environment only) |
| `GET /api/v1/sessions/{session_id}/fs/{path}:download` | Download a file (binary stream) |

### `POST /api/v1/sessions/{session_id}/fs:list`

Lists the entries of a directory in the session workspace, optionally recursing into subdirectories.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `session_id` | path | string | Required. Session id |
| `path` | body | string | Directory to list, relative to the session work directory. Default `.` |
| `depth` | body | integer | Recursion depth, 1–10. Default `1` |
| `limit` | body | integer | Maximum number of entries in `items`, 1–1000. Default `200`. Subdirectory entries are not subject to this limit |
| `show_hidden` | body | boolean | Include dotfiles. Default `false` |
| `follow_gitignore` | body | boolean | Skip gitignored paths. Default `true` |
| `exclude_globs` | body | string[] | Additional globs to skip |
| `allow_ignored_globs` | body | string[] | Globs to let through even when gitignored (e.g. `.tmp`). Ignored ancestor directories of a match are kept so the match stays reachable. Allowing dot-paths also requires `show_hidden: true` |
| `allow_external_symlinks` | body | boolean | When `true`, allows `path` to point outside the workspace through a symlink, and treats symlinked directories whose targets are outside the workspace as directories (marks `is_directory` and recurses into them). Default `false` |
| `sort` | body | string | `type_first` (default) / `name_asc` / `name_desc` / `mtime_desc` / `size_desc` |
| `include_git_status` | body | boolean | Ignored by the current implementation; entries do not carry `git_status`. Default `false` |

On success, `data` is:

| Field | Type | Description |
| --- | --- | --- |
| `items` | object[] | The first-level [entry objects](#entry-object) |
| `truncated` | boolean | `true` when `limit` cut `items` short, or when entries expanded through symlinked directories exceed 10000 |
| `children_by_path` | object | Present only when `depth` is greater than 1 and subdirectories were expanded. Keys are the expanded subdirectory paths; values are the entry lists of those directories |

- `40409`: path not found (including a `path` that is not a directory)
- `40411`: permission denied by the host filesystem
- `41303`: the session is on a remote environment and a directory has more than 50000 entries
- `41304`: path escapes the session workspace

### `POST /api/v1/sessions/{session_id}/fs:read`

Reads a slice of a session file as text or base64.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `session_id` | path | string | Required. Session id |
| `path` | body | string | Required. File path, relative to the session work directory |
| `offset` | body | integer | Byte offset to start at. Default `0` |
| `length` | body | integer | Bytes to read, 1–10485760 (10 MiB). Default `1048576` (1 MiB) |
| `encoding` | body | string | `auto` (default) / `utf-8` / `base64` |
| `allow_external_symlinks` | body | boolean | When `true`, allows reading a file that points outside the workspace through a symlink. Default `false` |

With `encoding` set to `auto`, text comes back as `utf-8` (non-UTF-8 text is transcoded) and binary content as `base64`. With `encoding` set to `utf-8`, the server forces a text read and rejects binary files.

On success, `data` is:

| Field | Type | Description |
| --- | --- | --- |
| `path` | string | File path, relative to the session work directory |
| `content` | string | The content read |
| `encoding` | string | The encoding actually used: `utf-8` / `base64` |
| `size` | integer | Full file size in bytes |
| `truncated` | boolean | `true` when more content follows the range read |
| `etag` | string | The file's ETag |
| `mime` | string | MIME type |
| `language_id` | string | Language identifier. Present only when the content is returned as `utf-8` and the language can be detected from the file name |
| `line_count` | integer | Number of lines in the returned content. Present only when the content is returned as `utf-8` |
| `is_binary` | boolean | Whether the file is binary |

- `40409`: path not found
- `40411`: permission denied by the host filesystem
- `40906`: path is a directory
- `40907`: the file is binary but `encoding: "utf-8"` was requested
- `41302`: the file is larger than 10 MiB (judged by the full file size, regardless of `offset` and `length`)
- `41304`: path escapes the session workspace

### `POST /api/v1/sessions/{session_id}/fs:list_many`

Lists several session directories in one call. When a path fails, its error goes into the response and the request as a whole still succeeds.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `session_id` | path | string | Required. Session id |
| `paths` | body | string[] | Required. Directories to list, 1–100 entries |

The remaining body fields `depth`, `limit`, `show_hidden`, `follow_gitignore`, `exclude_globs`, `sort`, and `include_git_status` have the same types, ranges, and defaults as in [`fs:list`](#post-api-v1-sessions-session-id-fs-list). When `depth` is greater than 1, the server still recurses, but the response contains only the first-level entries of each directory.

On success, `data` is:

| Field | Type | Description |
| --- | --- | --- |
| `results` | object | A map from each successfully listed path to its first-level [entry objects](#entry-object) |
| `truncated_paths` | string[] | Paths whose listing hit `limit`. Omitted when there are none |
| `partial_errors` | object | A map from each failed path to its `{ code, msg }` error. Omitted when nothing failed |

- `41304`: a path escapes the session workspace (the whole request fails)

### `POST /api/v1/sessions/{session_id}/fs:stat`

Stats a single path in the session workspace.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `session_id` | path | string | Required. Session id |
| `path` | body | string | Required. Path to stat, relative to the session work directory |

On success, `data` is the path's [entry object](#entry-object).

- `40409`: path not found
- `40411`: permission denied by the host filesystem
- `41304`: path escapes the session workspace

### `POST /api/v1/sessions/{session_id}/fs:stat_many`

Stats several session paths in one call. A path that cannot be read reports `null` instead of failing the whole request.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `session_id` | path | string | Required. Session id |
| `paths` | body | string[] | Required. Paths to stat, 1–1000 entries |

On success, `data.entries` maps each requested path to its [entry object](#entry-object), or to `null` when the path cannot be read (including when it does not exist).

- `41304`: a path escapes the session workspace (the whole request fails)

### `POST /api/v1/sessions/{session_id}/fs:mkdir`

Creates a directory in the session workspace.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `session_id` | path | string | Required. Session id |
| `path` | body | string | Required. Directory to create, relative to the session work directory |
| `recursive` | body | boolean | Create missing parent directories. Default `false` |

On success, `data` is the created directory's [entry object](#entry-object). With `recursive: true`, an existing directory also succeeds and returns that directory's entry object.

- `40409`: parent directory not found (non-recursive create), or a component of the path is not a directory
- `40411`: permission denied by the host filesystem
- `40919`: path already exists (with `recursive: true`, only when the existing path is not a directory)
- `41304`: path escapes the session workspace

### `POST /api/v1/sessions/{session_id}/fs:search`

Fuzzy-searches file and directory names in the session workspace. An empty `query` string lists the top-level entries instead.

The `{session_id}` slot also accepts a workspace reference (a [registered workspace](#workspaces) id or an absolute root path); the server then searches that workspace. This form is for draft sessions that have not been created yet. The first-class session-less endpoint is [`POST /api/v1/workspace/fs:search`](#post-api-v1-workspace-fs-search).

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `session_id` | path | string | Required. Session id, or a workspace reference |
| `query` | body | string | Required. Search text; `""` lists the top level |
| `limit` | body | integer | Maximum hits, 1–200. Default `50` |
| `include_globs` | body | string[] | Keep only paths matching one of these globs |
| `exclude_globs` | body | string[] | Skip paths matching these globs |
| `follow_gitignore` | body | boolean | Skip gitignored paths when `true`. Default `false` |

On success, `data` is:

| Field | Type | Description |
| --- | --- | --- |
| `items[].path` | string | Hit path |
| `items[].name` | string | Hit name |
| `items[].kind` | string | `file` / `directory` / `symlink` |
| `items[].score` | number | Fuzzy-match score, between 0 and 1 |
| `items[].match_positions` | integer[] | Matched character offsets |
| `truncated` | boolean | `true` when hits beyond `limit` were dropped |

Hits are ordered by match quality first; at equal quality, ordinary hits come before ignored hits. When ignored hits are included, the server may run one supplemental scan.

- `40401`: the reference is neither a session nor a resolvable workspace (replaces the "session not found" meaning in the [common error codes](#common-rules))
- `40409`: `query` is empty and the workspace root does not exist
- `40411`: `query` is empty and the host filesystem denies reading the workspace root
- `41303`: the session is on a remote environment and a directory has more than 50000 entries

### `POST /api/v1/sessions/{session_id}/fs:grep`

Searches file contents in the session workspace. Matching is by literal string by default, and by regular expression with `regex: true`.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `session_id` | path | string | Required. Session id |
| `pattern` | body | string | Required. Text or regular expression to search for |
| `regex` | body | boolean | Treat `pattern` as a regular expression. Default `false` |
| `case_sensitive` | body | boolean | Match case. Default `true` |
| `include_globs` | body | string[] | Keep only files matching one of these globs |
| `exclude_globs` | body | string[] | Skip files matching these globs |
| `follow_gitignore` | body | boolean | Skip gitignored paths. Default `true` |
| `max_files` | body | integer | Maximum files to scan, 1–10000. Default `200` |
| `max_matches_per_file` | body | integer | Matches kept per file, 1–10000. Default `50` |
| `max_total_matches` | body | integer | Total matches kept, 1–100000. Default `5000` |
| `context_lines` | body | integer | Context lines carried with each match, 0–10. Default `2` |

On success, `data` is:

| Field | Type | Description |
| --- | --- | --- |
| `files[].path` | string | File path |
| `files[].matches[].line` | integer | Line of the match |
| `files[].matches[].col` | integer | Column of the match |
| `files[].matches[].text` | string | Text of the matching line |
| `files[].matches[].before` | string[] | Context before the match, at most `context_lines` lines |
| `files[].matches[].after` | string[] | Context after the match, at most `context_lines` lines |
| `files_scanned` | integer | Number of files scanned |
| `truncated` | boolean | `true` when one of the match budgets cut the results short |
| `elapsed_ms` | integer | Elapsed time in milliseconds |

- `41305`: the search timed out

### `POST /api/v1/sessions/{session_id}/fs:git_status`

Reads Git status, optionally limited to a set of paths. With `root`, entry paths are relative to that directory. Without it, the whole Git worktree is queried and entry paths are relative to the repository root.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `session_id` | path | string | Required. Session id |
| `root` | body | string | Workspace directory to limit the query to; a relative path resolves from the session work directory. Omit to query the whole Git worktree |
| `paths` | body | string[] | Limit the status to these paths. With `root`, relative paths resolve from that directory; otherwise from the session work directory |
| `include_pull_request` | body | boolean | Include the linked pull request. Default `true` |

On success, `data` is:

| Field | Type | Description |
| --- | --- | --- |
| `branch` | string | Current branch name. Empty string in detached HEAD state |
| `ahead` | integer | Commits ahead of the upstream branch; `0` without an upstream branch |
| `behind` | integer | Commits behind the upstream branch; `0` without an upstream branch |
| `entries` | object | A map from each changed path to its status: `clean` / `modified` / `added` / `deleted` / `renamed` / `untracked` / `ignored` / `conflicted` |
| `additions` | integer | Lines added in the working tree relative to `HEAD` (staged and unstaged changes, excluding untracked files), limited by `root` and `paths`. `0` when there are no changes or the repository has no commits yet |
| `deletions` | integer | Lines deleted in the working tree relative to `HEAD`, counted the same way as `additions` |
| `pullRequest` | object \| null | The linked pull request, with the same shape and value rules as [`fs:pull_request`](#post-api-v1-sessions-session-id-fs-pull-request). `null` with `include_pull_request: false` |

- `40908`: git is unavailable (not a repository, or no git binary), or `root` does not exist or is not a directory
- `41304`: path escapes the session workspace, or, with `root`, a path in `paths` escapes that directory

### `POST /api/v1/sessions/{session_id}/fs:git_status:batch`

Reads Git status for several workspace directories in one call. When a directory fails, its error goes into `errors` and the request as a whole still succeeds.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `session_id` | path | string | Required. Session id |
| `roots` | body | string[] | Required. Workspace directories to query, 1–32 entries |
| `include_pull_request` | body | boolean | Include the linked pull request in each result. Default `true` |

On success, `data` is `{ results, errors }`. `results` maps each successful root to the same status object as [`fs:git_status`](#post-api-v1-sessions-session-id-fs-git-status). `errors` maps each failed root to its `{ code, msg }` error, using the same error codes as the single-directory endpoint.

No error codes beyond the [common error codes](#common-rules).

### `POST /api/v1/sessions/{session_id}/fs:pull_request`

Reads the pull request linked to a given directory in the session workspace.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `session_id` | path | string | Required. Session id |
| `root` | body | string | Workspace directory to query; a relative path resolves from the session work directory. Defaults to the session work directory |

On success, `data` is `{ number, state, url }`, where `state` is `open` / `merged` / `closed` / `draft`. `data` is `null` when no pull request is found.

The server queries the current branch's pull request with `gh` (the GitHub CLI) and caches the result per directory and branch for 60 seconds. It also returns `null` when the directory is not on any branch, `gh` is unavailable, or the query fails.

- `40908`: git is unavailable (not a repository, or no git binary), or `root` does not exist or is not a directory
- `41304`: path escapes the session workspace

### `POST /api/v1/sessions/{session_id}/fs:pull_request:batch`

Reads the pull requests linked to several workspace directories in one call. When a directory fails, its error goes into `errors` and the request as a whole still succeeds.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `session_id` | path | string | Required. Session id |
| `roots` | body | string[] | Required. Workspace directories to query, 1–32 entries |

On success, `data` is `{ results, errors }`. `results` maps each successful root to the same object as [`fs:pull_request`](#post-api-v1-sessions-session-id-fs-pull-request), or `null`. `errors` maps each failed root to its `{ code, msg }` error.

No error codes beyond the [common error codes](#common-rules).

### `POST /api/v1/sessions/{session_id}/fs:diff`

Returns the unified git diff of a single file in a given directory of the session workspace.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `session_id` | path | string | Required. Session id |
| `path` | body | string | Required. File to diff, relative to `root` |
| `root` | body | string | Workspace directory to query; a relative path resolves from the session work directory. Defaults to the session work directory |

On success, `data` is:

| Field | Type | Description |
| --- | --- | --- |
| `path` | string | File path, relative to `root` |
| `diff` | string | Unified diff text. An untracked file is output as a new file |
| `truncated` | boolean | `true` when the diff text exceeded 1048576 characters and was truncated to that length |

- `40409`: the file does not exist and has no corresponding change in Git
- `40908`: git is unavailable (not a repository, or no git binary), or `root` does not exist or is not a directory
- `41304`: path escapes the session workspace, or `path` escapes `root`

### `POST /api/v1/sessions/{session_id}/fs:open`

Opens a session file on the host. `local` environment only.

When the server process has the environment variable `KIMI_CODE_EDITOR`, `VISUAL`, or `EDITOR` set, the server takes the first non-empty value in that order as the editor command and opens the file with it. When none is set, the file opens with the host operating system's default program.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `session_id` | path | string | Required. Session id |
| `path` | body | string | Required. File to open, relative to the session work directory |
| `line` | body | integer | Line number to jump to (positive integer). Takes effect only when the editor command is `code`, `cursor`, or `windsurf` |

On success, `data` is `{ opened: true }`.

- `40409`: path not found
- `40411`: permission denied by the host filesystem
- `41304`: path escapes the session workspace
- `50001`: the session is not on the `local` environment, or the opener could not be started

### `POST /api/v1/sessions/{session_id}/fs:open-in`

Opens a session file or directory in a given host application. `local` environment only.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `session_id` | path | string | Required. Session id |
| `app_id` | body | string | Required. Target application: `finder` / `cursor` / `vscode` / `iterm` / `terminal` |
| `path` | body | string | Required. File or directory to open, relative to the session work directory |
| `line` | body | integer | Line number to jump to (positive integer). Takes effect only when `app_id` is `cursor` or `vscode` |

On success, `data` is `{ opened: true }`.

- `40409`: path not found
- `40411`: permission denied by the host filesystem
- `41304`: path escapes the session workspace
- `50001`: the session is not on the `local` environment, or the application failed to launch

### `POST /api/v1/sessions/{session_id}/fs:reveal`

Reveals a session file in the host operating system's file manager. `local` environment only.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `session_id` | path | string | Required. Session id |
| `path` | body | string | Required. File to reveal, relative to the session work directory |

On success, `data` is `{ revealed: true }`.

- `40409`: path not found
- `40411`: permission denied by the host filesystem
- `41304`: path escapes the session workspace
- `50001`: the session is not on the `local` environment, or the file manager could not be started

### `GET /api/v1/sessions/{session_id}/fs/{path}:download`

Downloads a file from the session workspace. `{path}` is the file path relative to the session work directory, followed by the literal `:download` suffix. The response is a binary stream with Range and ETag support; see [Binary and streaming endpoints](#binary-and-streaming-endpoints).

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `session_id` | path | string | Required. Session id |
| `path` | path | string | Required. File path relative to the session work directory, plus the `:download` suffix |
| `allow_external_symlinks` | query | string | `true` / `false`. When `true`, allows downloading a file that points outside the workspace through a symlink. Default `false` |

- `40001`: the path is empty, the `:download` suffix is missing, or `allow_external_symlinks` is not `true` / `false`
- `40401`: session not found
- `40409`: path not found
- `40411`: permission denied by the host filesystem
- `40420`: the session's environment not found
- `40906`: path is a directory
- `40926`: the session's environment is unavailable
- `40930`: the session requires a newer server to read
- `41304`: path escapes the session workspace

## Workspace file system

List directories, search files, and suggest `@` file-completion candidates directly in a given workspace, without a session. The workspace is given by the `workspace` field in the request body, not by the URL.

| Method and path | Description |
| --- | --- |
| `POST /api/v1/workspace/fs:list` | Session-less workspace directory listing |
| `POST /api/v1/workspace/fs:search` | Session-less workspace search |
| `POST /api/v1/workspace/fs:suggest` | Session-less file-completion candidates (for `@` file mentions) |

### `POST /api/v1/workspace/fs:list`

The session-less form of [`fs:list`](#post-api-v1-sessions-session-id-fs-list).

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `workspace` | body | string | Required. A [registered workspace](#workspaces) id, or an absolute root path (registered on the spot) |
| `path` | body | string | Directory to list, relative to the workspace root. Default `.` |
| `depth` | body | integer | Recursion depth, 1–10. Default `1` |
| `limit` | body | integer | Maximum number of entries in `items`, 1–1000. Default `200`. Subdirectory entries are not subject to this limit |
| `show_hidden` | body | boolean | Include dotfiles. Default `false` |
| `follow_gitignore` | body | boolean | Skip gitignored paths. Default `true` |
| `exclude_globs` | body | string[] | Additional globs to skip |
| `allow_ignored_globs` | body | string[] | Globs to show even when gitignored |
| `allow_external_symlinks` | body | boolean | When `true`, allows `path` to point outside the workspace through a symlink, and treats symlinked directories whose targets are outside the workspace as directories (marks `is_directory` and recurses into them). Default `false` |
| `sort` | body | string | `type_first` (default) / `name_asc` / `name_desc` / `mtime_desc` / `size_desc` |

On success, `data` has the same shape as for [`fs:list`](#post-api-v1-sessions-session-id-fs-list).

- `40409`: path not found or not a directory
- `40411`: permission denied by the host filesystem
- `41304`: path escapes the workspace, including through a symlink when `allow_external_symlinks` is not enabled

### `POST /api/v1/workspace/fs:search`

The session-less form of [`fs:search`](#post-api-v1-sessions-session-id-fs-search).

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `workspace` | body | string | Required. A [registered workspace](#workspaces) id, or an absolute root path (registered on the spot) |
| `query` | body | string | Required. Search text; `""` lists the top level |
| `limit` | body | integer | Maximum hits, 1–200. Default `50` |
| `include_globs` | body | string[] | Keep only paths matching one of these globs |
| `exclude_globs` | body | string[] | Skip paths matching these globs |
| `follow_gitignore` | body | boolean | Skip gitignored paths when `true`. Default `false` |

On success, `data` is `{ items, truncated }`, with the same hit shape and ordering as [`fs:search`](#post-api-v1-sessions-session-id-fs-search).

- `40409`: `query` is empty and the workspace root does not exist
- `40411`: `query` is empty and the host filesystem denies reading the workspace root

### `POST /api/v1/workspace/fs:suggest`

Suggests file and directory completion candidates in a workspace without a session. This is the backend for `@` file mentions in the input box.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `workspace` | body | string | Required. A [registered workspace](#workspaces) id, or an absolute root path (registered on the spot) |
| `query` | body | string | Required. Partial path text to complete |
| `limit` | body | integer | Maximum candidates, 1–200. Default `50`; fd searches return at most `20` |
| `follow_gitignore` | body | boolean | Skip gitignored paths when `true`. Default `false` |
| `show_hidden` | body | boolean | Include dotfiles. Default `false`; fd searches always include them |
| `stream` | body | boolean | Return NDJSON preview / final events when `true`. Default `false` |
| `include_globs` | body | string[] | Keep only paths matching one of these globs |
| `exclude_globs` | body | string[] | Skip paths matching these globs |

On success, `data` is `{ items, truncated }`, where each item is `{ path, name, kind, score, match_positions }`, the same shape as a [`fs:search`](#post-api-v1-sessions-session-id-fs-search) hit. Candidates are ordered by match quality first; at equal quality, ordinary candidates come before ignored candidates.

When fd (a command-line file finder) is available, the server uses the same strategy as local `@` completion: hidden paths are always included, each root scans at most 100 entries per pass, and at most 20 items are returned. Matches beyond the scan cap may be missed. When ignored candidates are included, the server may run one supplemental `--no-ignore-vcs` scan. When fd is unavailable, the server falls back to the ripgrep / Node implementation.

With `stream: true`, the response is NDJSON (one JSON object per line) instead of a single JSON object. Each envelope's `data` contains `phase` (`preview` / `final` / `error`) and the same result fields as above. A preview carries ordinary fd candidates with `truncated: true`; the final result, sent after the ignored scan finishes, replaces the preview. Closing the connection cancels the search.

When an error occurs after the stream has started, the server writes one envelope line with `phase: "error"` and then ends the stream; the envelope `code` is still `0`. The error goes in `data.error` as `{ code, message }`: `code` is the server's internal string error identifier (such as `fs.path_not_found`), or the number `50001` for an unrecognized exception.

No error codes beyond the [common error codes](#common-rules).

## Host files

Access the file system of the machine running the server directly by absolute path, without a session or workspace. These endpoints serve cross-directory file completion and the folder picker. `fs:content` and `fs:mkdir` can also reach the file system of another registered environment through `environment_id`.

| Method and path | Description |
| --- | --- |
| `POST /api/v1/fs:suggest` | File-completion candidates across one or more absolute root directories |
| `GET /api/v1/fs:browse` | List host directories (for the folder picker) |
| `GET /api/v1/fs:home` | The user's home directory and recent workspaces |
| `GET /api/v1/fs:content` | Read the raw bytes of any host file (gated only by the token; be careful when exposing the port) |
| `POST /api/v1/fs:mkdir` | Create a directory by absolute path |

### `POST /api/v1/fs:suggest`

Suggests file and directory completion candidates across one or more absolute root directories, without a session or workspace; nothing is registered. The first root is the primary root: candidates under it come back as relative paths, and candidates under the other roots as absolute paths. Overlapping roots are searched once.

The body takes `roots` in place of `workspace`. The remaining fields `query`, `limit`, `follow_gitignore`, `show_hidden`, `stream`, `include_globs`, and `exclude_globs` are the same as for [`POST /api/v1/workspace/fs:suggest`](#post-api-v1-workspace-fs-suggest).

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `roots` | body | string[] | Required. 1–32 absolute directory paths; the first is the primary root |

The response, including the NDJSON form with `stream: true`, is the same as for [`POST /api/v1/workspace/fs:suggest`](#post-api-v1-workspace-fs-suggest).

- `40001`: body validation failure, including a root that is not an absolute path
- `40409`: a root does not exist or is not a directory (`msg` names it)

### `GET /api/v1/fs:browse`

Lists the subdirectories of a host directory. This is the backend of the folder picker.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `path` | query | string | Absolute directory path. Defaults to the user's home directory |

On success, `data` is:

| Field | Type | Description |
| --- | --- | --- |
| `path` | string | The resolved directory |
| `parent` | string \| null | Parent directory; `null` at the filesystem root |
| `entries[].name` | string | Subdirectory name |
| `entries[].path` | string | Subdirectory path |
| `entries[].is_dir` | boolean | Always `true` |

- `40001`: `path` is not absolute
- `40409`: path not found or not a directory
- `40411`: permission denied

### `GET /api/v1/fs:home`

Returns the folder picker's landing data. No parameters.

On success, `data` is `{ home, recent_roots }`: `home` is the user's home directory, and `recent_roots` lists the roots of registered workspaces, at most 8.

### `GET /api/v1/fs:content`

Streams the raw bytes of any file on the host filesystem; with `environment_id`, reads that environment's file system instead. This endpoint is gated only by the API token (see [Authentication](#authentication)), so be careful when exposing the port. The response supports Range requests and ETag caching; see [Binary and streaming endpoints](#binary-and-streaming-endpoints).

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `path` | query | string | Required. Absolute file path |
| `environment_id` | query | string | Id of the environment to read, available from [`GET /api/v1/sessions/{session_id}/environments`](#get-api-v1-sessions-session-id-environments). Default `local` (the machine running the server) |

- `40001`: `path` is missing or not absolute, or the path is neither a regular file nor a directory (such as a device file or socket)
- `40409`: path not found
- `40411`: permission denied
- `40420`: the environment given by `environment_id` not found
- `40906`: path is a directory
- `40926`: the environment given by `environment_id` is unavailable or does not provide the file system capability

### `POST /api/v1/fs:mkdir`

Creates one directory on the host filesystem by absolute path. This is the backend of the folder picker's "New folder" action; with `environment_id`, it creates the directory on that environment's file system instead. Non-recursive: the parent directory must already exist.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `path` | body | string | Required. Absolute directory path |
| `environment_id` | body | string | Target environment id, available from [`GET /api/v1/sessions/{session_id}/environments`](#get-api-v1-sessions-session-id-environments). Default `local` (the machine running the server) |

On success, `data` is `{ path }`.

- `40001`: `path` is not absolute
- `40409`: parent path not found, or a component of the path is not a directory
- `40411`: permission denied
- `40420`: the environment given by `environment_id` not found
- `40919`: path already exists
- `40926`: the environment given by `environment_id` is unavailable or does not provide the file system capability

## Binary and streaming endpoints

The following endpoints return binary streams instead of a JSON payload. Their HTTP capabilities differ per endpoint:

| Method and path | Description | Range (206) | ETag / 304 |
| --- | --- | --- | --- |
| [`GET /api/v1/files/{file_id}`](#file-uploads) | Download an uploaded file | Yes | No (sends an `etag` header but ignores `If-None-Match`) |
| [`GET /api/v1/sessions/{session_id}/fs/{path}:download`](#get-api-v1-sessions-session-id-fs-path-download) | Download a session workspace file | Yes | Yes |
| [`GET /api/v1/fs:content`](#get-api-v1-fs-content) | Read any host file (gated only by the token; be careful when exposing the port) | Yes | Yes |
| [`POST /api/v1/sessions/{session_id}/export`](#post-api-v1-sessions-session-id-export) | Export the session with diagnostics (zip stream) | No | No |

Error semantics differ as well. `GET /api/v1/files/{file_id}`, `GET /api/v1/fs:content`, and session `:download` answer failures with real 4xx / 500 status codes, and the body is still the standard [response envelope](#response-envelope). Session export still reports errors in an HTTP 200 envelope. Ordinary JSON RPC endpoints keep the almost-always-200 convention, so clients must still check the envelope `code`.

# Kimi Agent Protocol (KAP) Specification (Beta)

The local server started by `kimi web` (as well as the server embedded in the Kimi Code desktop app) exposes the **Kimi Agent Protocol (KAP)**: an HTTP REST control plane (`/api/v1`) paired with a single-connection WebSocket event and task stream (`/api/v1/ws`).

> **How to use this document (for AI agents and client authors):**
>
> - **When NOT to use KAP**: If you only need a single unattended prompt/response in a script or CI job with no mid-turn steering, live UI rendering, or interactive callbacks, run `kimi -p "<task>" --output-format stream-json` instead of spinning up a KAP server.
> - **Behavioral constitution here; exact field schemas online**: This document defines connection bootstrap, role-scoped authentication, compatibility guarantees, core domain shapes, defensive WebSocket reduction rules, and the complete endpoint catalog. During implementation, fetch [`GET /openapi.json`](#online-schemas-and-additive-evolution) (REST) and [`GET /asyncapi.json`](#online-schemas-and-additive-evolution) directly from a running server to inspect exact request/response JSON Schemas and enums rather than guessing field shapes.

## Sections

1. **[Connection & Authentication](#connection-and-authentication)**: Subprocess `--json` bootstrap, connecting to a running CLI or Desktop instance (instance discovery + passwordless handshake or `kimi access`), and `viewer` / `operator` / `owner` role boundaries.
2. **[Protocol Conventions & Evolution](#protocol-conventions-and-evolution)**: Online schemas, additive-only `/api/v1` evolution, `meta.capabilities` feature probing, response envelopes, error codes, cross-process concurrency, and pagination.
3. **[Quick Start](#quick-start)**: Minimal zero-dependency Node.js 22+ walkthrough (`kimi web --port 0 --json` + session creation + WebSocket subscription + prompt submission).
4. **[Core Domain Shapes](#core-domain-shapes)**: Essential field mental models for `Session`, `Turn`, `Item` (`user_message`, `assistant_message`, `reasoning`, `tool_call`, `notification`, `system`), `Interaction`, `Task`, and `Agent` state.
5. **[WebSocket & Conversation Reduction Constitution](#websocket-and-conversation-reduction-constitution)**: Heartbeat, subscription ordering, defensive `Turn` / `Item` reduction formulas, streaming `item.started` / `item.delta` rules, `/steer` cross-turn & anti-deadlock semantics, approvals/questions, task byte-offset streaming, reconnection, and global events.
6. **[Complete Endpoint & WebSocket Catalog](#complete-endpoint-and-websocket-catalog)**: Full directory of `/api/v1` REST routes and `/api/v1/ws` frames with minimum role requirements (`viewer` / `operator` / `owner`) and `meta.capabilities` gates.

---

## Connection and authentication

All `/api/*` routes, `/openapi.json`, and `/asyncapi.json` require a bearer token, except `OPTIONS` preflights, `GET /api/v1/healthz`, static web assets outside `/api/`, and the two local handshake endpoints (`POST /api/v1/access/requests` and `POST /api/v1/access/requests/{request_id}:exchange`).

- **REST**: Send `Authorization: Bearer <token>`.
- **WebSocket (`/api/v1/ws`)**: Send `Authorization: Bearer <token>` on the HTTP upgrade request, or pass subprotocol `kimi-code.bearer.<token>` (recommended in browser environments where custom headers on `new WebSocket(...)` are unavailable).

**Never read `~/.kimi-code/server.token` from external clients or orchestrators.** That file is an internal CLI host credential and is rejected by the Desktop embedded server. Always use Mode A or Mode B below.

### Mode A: Spawn a dedicated subprocess (`kimi web --port 0 --json`)

Recommended for multi-agent orchestrators, automated runners, and standalone third-party clients that own the server process lifecycle:

```sh
kimi web --port 0 --json
```

- Automatically implies `--no-open`, routes server logs to `stderr`, and **never reads, creates, or exposes `~/.kimi-code/server.token`**.
- Generates an in-memory ephemeral `operator` token (`kap_...`) valid strictly for the lifetime of that child process.
- Once listening, writes **one single-line JSON object** (no ANSI color codes, `origin` has no trailing slash) as the first line of `stdout`:

```json
{"origin":"http://127.0.0.1:54123","ws_url":"ws://127.0.0.1:54123/api/v1/ws","token":"kap_...","role":"operator","kimi_agent_protocol_version":"0.1.0"}
```

Read the first line from `stdout`, parse JSON, concatenate paths directly onto `origin` (e.g. `${origin}/api/v1/sessions`), and stop the child process with `SIGTERM` / `SIGINT` when finished.

### Mode B: Connect to an already-running CLI or Desktop instance

When attaching to a user's running `kimi web` server or Kimi Code Desktop app:

1. **Discover live local instances**: Scan `~/.kimi-code/server/instances/*.json` (respecting `KIMI_CODE_HOME` when set). Each file contains:
   ```json
   {
     "server_id": "01JZX...",
     "pid": 48210,
     "host": "127.0.0.1",
     "port": 58627,
     "started_at": 1763000000000,
     "heartbeat_at": 1763000015000,
     "host_version": "2.6.2"
   }
   ```
   Verify `pid` is alive (e.g. `kill(pid, 0)`) and confirm `GET http://<host>:<port>/api/v1/healthz` returns `200`.
2. **Option B1 — Passwordless approval handshake** (works seamlessly with both Desktop/Web UI and pure CLI `kimi web`):
   - Call `POST /api/v1/access/requests` (unauthenticated; rate-limited; validates `Host`, and rejects any browser `Origin` not on the server's allowlist with `403`):
     ```json
     { "client_name": "Acme Orchestrator", "role": "operator" }
     ```
     Response `data`:
     ```json
     {
       "request_id": "areq_01JZX...",
       "device_code": "kapd_...",
       "user_code": "ABCD-2345",
       "expires_at": "2026-11-17T04:05:00.000Z"
     }
     ```
   - Show `user_code` (`ABCD-2345`) to the user:
     - **Desktop / Web UI**: Automatically pops up a confirmation dialog (`Acme Orchestrator requests read & write access (verification code: ABCD-2345) — Reject / Allow`) for online `owner` connections.
     - **Pure CLI (`kimi web`)**: Prints `Run: kimi access approve ABCD-2345` to `stderr`, allowing headless/SSH users to approve from another shell without any GUI.
   - Poll `POST /api/v1/access/requests/{request_id}:exchange` every 1–2 s with `{ "device_code": "kapd_..." }`:
     - Waiting: `{ "status": "pending", "expires_at": "..." }`
     - Denied / timed out: `{ "status": "rejected" }` or `{ "status": "expired" }`
     - Approved: `{ "status": "approved", "token": "kap_...", "role": "operator", "principal_id": "tok_..." }`
   - **Store `token` securely on receipt**: `:exchange` returns the plaintext `kap_...` token **once** and erases it on the server; subsequent calls return `code: 40936`.
3. **Option B2 — User-issued CLI token**: Ask the user to run `kimi access create --name "<client>" [--role operator|viewer]` (defaults to `operator`) and paste the printed `kap_...` token into your client. Users can audit or revoke tokens at any time via `kimi access list` and `kimi access revoke <principal_id>` (running `kap-server` instances hot-reload `~/.kimi-code/server/access_tokens.json` and immediately close active WebSocket connections of revoked principals with code `1008`).

### Role hierarchy and permission boundaries

Every authenticated caller has a role (`viewer` < `operator` < `owner`), inspectable via `GET /api/v1/access/me` (`{ role, principal_id?, name? }`). Insufficient role permissions return HTTP `403` (or a WebSocket `response` frame) with `code: 40302` (`ACCESS_FORBIDDEN`):

| Role | Credential source | Permitted surface | Blocked (`40302` `ACCESS_FORBIDDEN`) |
| --- | --- | --- | --- |
| `viewer` | External `kap_...` with `role: "viewer"` | Scoped read-only `GET` endpoints (sessions, turns, prompts, models, providers, workspaces, redacted config, skills, tools, session media/file downloads, `/access/me`, `/openapi.json`, `/asyncapi.json`) + WebSocket `subscribe`, `unsubscribe`, `task.watch`, `task.unwatch`, `ping`/`pong` | Every mutating HTTP method (`POST`/`PUT`/`PATCH`/`DELETE`); WebSocket `task.stop` and `task.background`; arbitrary host path reads (`/fs:browse`, `/fs:home`, `/fs:content`); `/workspaces/project-config-dirs`; `/access/principals*`; `/remote-control*`; `/oauth/login`; `/debug/*` |
| `operator` | Default for `kimi web --json`, `kimi access create`, and handshakes | Everything in `viewer` + full session creation/actions (`POST /sessions`, `:cancel`, `:compact`, `:undo`, `:btw`, `:fork`, `:archive`, `:restore`, `:delete`, `:reload`, `:takeover`, `/profile`, `/title/generate`, `/export`, `/rating`), `/prompts`, `/steer`, `/skills/{name}:activate`, `/interactions/{id}`, `/files` upload & delete, `/search`, WS `task.stop` & `task.background`, and workspace-bounded `/sessions/{id}/fs:*` + `/workspace/fs:*` (registered `workspace_id` only) | Global `/config` writes, `/providers` & `/models/*:set_default` writes, `/oauth/*` login/logout, `/remote-control*`, `/plugins` & `/capabilities` installs/mutations, global `/mcp/*` writes/tests/OAuth, arbitrary host `/fs:browse` / `/fs:home` / `/fs:content` / `/fs:mkdir` / `/fs:suggest`, `/workspaces` mutations (and raw unregistered paths in `/workspace/fs:*`), `/shutdown`, `/debug/*`, and `/access/requests/{id}:resolve` / `/access/principals*` |
| `owner` | Host credentials (Desktop launch secret, CLI `--password`, CLI `server.token`) | Full host administration across all routes and WebSocket events | None |

---

## Protocol conventions and evolution

### Online schemas and additive evolution

A running server serves live machine-readable schemas generated directly from its Zod validation definitions (authenticated with any `viewer+` token; returns raw JSON without the `/api/v1` envelope):

- `GET /openapi.json` — OpenAPI 3.0 specification for all public `/api/v1` REST endpoints.
- `GET /asyncapi.json` — AsyncAPI 3.1 specification for all `/api/v1/ws` client commands and server frames.

KAP `/api/v1` enforces three evolution rules so third-party clients work reliably across older and newer Kimi Code installations (no `X-KAP-Version` header is used):

1. **Additive-only shapes**: Routes, optional parameters, response fields, and WebSocket frame types/fields are only added, never deleted or renamed, and optional request parameters never become required. Clients must ignore unknown JSON properties, unknown `Item` or `PushEvent` variants, and unknown WebSocket frame `type`s.
2. **Stable default behavior**: Omitting newly added optional parameters preserves the existing behavior of every endpoint (new behaviors opt in via optional parameters such as `include_background` on `:cancel`, or new `:{action}` suffixes).
3. **Capability probing via `GET /api/v1/meta`**: Instead of parsing `server_version`, inspect `data.capabilities` on `GET /api/v1/meta` before enabling optional UI controls or calling newly added endpoints:
   ```js
   const { data: meta } = await fetch(`${origin}/api/v1/meta`, { headers }).then((r) => r.json());
   if (meta.capabilities.access_tokens) {
     const { data: me } = await fetch(`${origin}/api/v1/access/me`, { headers }).then((r) => r.json());
   }
   ```
   When a running server predates an optional feature, hide or gracefully degrade that action rather than failing at session boot.

### Submitting attachments & activating skills

- **File / image attachments**: Upload via `POST /api/v1/files` (`multipart/form-data` with field `file`, max size governed by server limits), receive `{ id, name, media_type, size }`, and reference `file_id` inside `POST /api/v1/sessions/{session_id}/prompts` `content` parts (see `promptSubmissionSchema` in `GET /openapi.json` for exact text, image, audio, video, and file content part variants).
- **Skill invocation**: List available skills via `GET /api/v1/sessions/{session_id}/skills`, then either attach `skills: [{ name, args? }]` on `POST .../prompts` or invoke `POST /api/v1/sessions/{session_id}/skills/{name}:activate` directly.

### Wire conventions & response envelope

- **Field naming & units**: KAP wire fields use `snake_case` (passthrough exceptions: managed OAuth `limit5h`/`usedRatio`/`resetAt`/`userInfo`/`userId` and `:undo` `40911` `data` `{ reason, requestedCount, undoableCount }`). Timestamps are ISO 8601 strings; durations end with `_ms`.
- **Opaque IDs**: Treat `session_id`, `turn_id`, `item_id`, `interaction_id`, `task_id`, `workspace_id`, and `principal_id` as opaque strings. `turn_id` and `item_id` are deterministic across WebSocket frames and `GET .../turns` history.
- **Standard JSON envelope**: Every `/api/v1` JSON response (except `204` empty responses and raw binary streams) has the shape:
  ```json
  {
    "code": 0,
    "msg": "success",
    "data": {},
    "request_id": "01JZX4A6E7M8V0R3Q0N2K2M5Q9"
  }
  ```
  Always check `code === 0` first (`details` optionally provides structured context such as `{ path, message }[]` on `40001` or lock holder metadata on `40931`). Most domain errors return HTTP `200` with non-zero `code`; HTTP status differs only for:
  - `401` (`40101` missing/invalid credential), `403` (`40301` disallowed `Host`/`Origin` or `40302` `ACCESS_FORBIDDEN`), `429` (`42901` rate limit).
  - `201` on provider creation/import (still enveloped), `204` on provider deletion (empty body).
  - Binary download routes (`GET /api/v1/files/{file_id}`, `GET /api/v1/sessions/{session_id}/media/{file_id}`, `GET /api/v1/sessions/{session_id}/fs/*:download`, `GET /api/v1/fs:content`): return raw bytes on `200`/`206` (`Range`), empty `304` on `If-None-Match`, and real `4xx`/`500` HTTP statuses with a JSON error envelope on failure (`POST /api/v1/sessions/{session_id}/export` returns a `200` `application/zip` stream or a `200` JSON error envelope).

### Core error codes

HTTP envelopes and WebSocket `response` frames share the same `code` table:

| Code(s) | Meaning |
| --- | --- |
| `0` | Success |
| `40001` | Validation failed (`details` lists offending fields) |
| `40003`–`40006` | OAuth-managed provider (`40003`), invalid catalog/registry import (`40004`/`40005`), duplicate workspace directory (`40006`) |
| `40101` | Missing or invalid bearer token (HTTP `401`) |
| `40110`–`40113` | LLM auth not ready: provider unconfigured (`40110`), API key missing (`40111`), key rejected (`40112`), model unresolved (`40113`) |
| `40301` / `40302` | Disallowed `Host` or `Origin` (`40301`, HTTP `403`); insufficient token role or invalid handshake `device_code` (`40302` `ACCESS_FORBIDDEN`, HTTP `403`) |
| `40401`–`40423` | Not found: session/agent (`40401`), prompt (`40402`), interaction (`40404`), task (`40406`), file (`40407`), MCP server (`40408`), fs path (`40409`), workspace (`40410`), fs permission (`40411`), provider (`40412`), model (`40413`), skill (`40415`), catalog (`40417`), capability (`40418`), plugin (`40419`), environment (`40420`), turn (`40421`), access request (`40422`), access principal (`40423`) |
| `40901` / `40902` | Session or agent busy (`40901`); interaction already ended (`40902`) |
| `40906`–`40921` | Path is directory (`40906`), binary file (`40907`), git unavailable (`40908`), compaction unable (`40910`), undo unavailable (`40911`), skill not activatable (`40912`), goal conflict (`40913`–`40918`, `40920`), path exists (`40919`), provider exists (`40921`) |
| `40922`–`40936` | `page_token` mismatch (`40922`), title unavailable (`40923`), capability conflict (`40924`/`40925`), environment unavailable (`40926`), `prompt_id` payload conflict (`40927`), remote control running (`40928`), MCP OAuth failed (`40929`), wire version too new (`40930`), session occupied by another process (`40931`), session stale (`40932`), task not detachable (`40933`), plugin catalog changed (`40934`), invalid Tower mode (`40935`), access request already resolved/exchanged (`40936`) |
| `41001`–`41004` | Expired approval (`41001`), question (`41002`), uploaded file (`41003`), or access request (`41004`) |
| `41301`–`41305` | Upload/file too large (`41301`/`41302`), too many fs results (`41303`), path escapes workspace (`41304`), grep timeout (`41305`) |
| `42901` | Rate limit / temporary ban on repeated auth or handshake failures (HTTP `429`) |
| `50001`–`50004` | Internal error (`50001`), persistence failure (`50003`), catalog unavailable (`50004`) |
| `6xxxx` | Tool execution failed (`60001`) or tool unavailable (`60002`) |

**Cross-process concurrency (`40931` & `40932`)**: Clients connected to the *same* `kap-server` share live sessions in memory and never hit lock errors. `40931` (`SESSION_OCCUPIED`) appears only when another OS process holds the session lock on disk (retry once finished, or call `:takeover` if the holder crashed). `40932` (`SESSION_STALE`) is auto-reloaded transparently on `/prompts`, `/skills`, and `:compact`, and surfaces directly only on `:undo` so callers can inspect updated turns first.

### Pagination styles

- **`GET /api/v1/sessions` & `POST /api/v1/search`**: Opaque `next_page_token` bound to query filters (changing filters returns `40922`). `GET /api/v1/sessions` also accepts 1-based `page` or flat-view `before_id` / `after_id` (mutually exclusive).
- **`GET /api/v1/sessions/{session_id}/agents/{agent_id}/turns`**: Pass the earliest loaded turn's `ordinal` as `before_ordinal` (with `page_size`, default 20, max 100) to page backward through conversation history.

---

## Quick start

Zero-dependency Node.js 22+ example spawning `kimi web --port 0 --json`, creating a session, subscribing over WebSocket, submitting a prompt, streaming the reply, and shutting down cleanly:

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
          content: [{ type: 'text', text: 'Summarize this repository in one sentence.' }],
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

---

## Core domain shapes

Use `GET /openapi.json` and `GET /asyncapi.json` for exhaustive field types; this section summarizes the key structural invariants clients rely on.

- **`Session` object** (returned by `/sessions` endpoints and global `session` WS events):
  - `{ id, workspace_id, cwd, title, created_at, updated_at, archived, archived_at?, activity: "idle" | "turn" | "background", pending_interaction: "none" | "approval" | "question", last_turn_outcome?: "completed" | "interrupted" | "failed", last_prompt?, metadata?, git? }`
  - `activity` is `"turn"` while `main` has a running turn, `"background"` when only subagents/background tasks/compaction are active, and `"idle"` otherwise. Active model, thinking, permission mode, context usage, and goal live on per-agent WebSocket state frames (`agent`, `context`, `goal`), not on `Session`.
- **`Turn` object** (in `turns`, `GET .../turns`, and without `items` in `turn.started` / `turn.ended`):
  - `{ turn_id, ordinal, turn_number, kind: "agent" | "system", status: "running" | "ended", outcome?: "completed" | "interrupted" | "failed", end_reason?, error?, retry?, started_at, ended_at?, duration_ms?, usage?, steps: Step[], items: Item[] }`
  - Sort turns by `ordinal` (0-based); pass `turn_number` to `/file-history/*` endpoints; `step.finish_reason` uses normalized values `"end_turn"`, `"tool_use"`, or `"interrupted"`.
- **`Item` discriminated union** (keyed by `type`, sharing `{ item_id, type, step_index?, status: "running" | "ended", outcome?, created_at }`):
  - `user_message`: `{ prompt_ids: string[], placement: "opener" | "steer", origin: { kind, ... }, text, attachments, skills, metadata? }` — retire optimistic local input bubbles when their `prompt_id` appears in `prompt_ids`.
  - `assistant_message`: `{ text }` — model reply markdown.
  - `reasoning`: `{ text, started_at, duration_ms? }` — model thinking trace.
  - `tool_call`: `{ name, stage: "input" | "awaiting_approval" | "executing", input?, input_text?, output?, error?, fields?, media?, note?, task_id?, interaction_id?, agent_refs?, display?, started_at, ended_at? }` — normal streaming/final result is in `output`; failed or interrupted output (including partial output before cancellation) is in `error`. `agent_refs` links child subagents (`{ agent_id, role: "child" | "member", swarm_index?, task_id? }[]`) which you can incrementally `subscribe` to.
  - `notification`: background task completion injected into history (`{ notification_id, title, body, severity, notification_type, task_id?, agent_id?, output? }`).
  - `system`: `kind: "compaction"` (context compaction summary divider) or `kind: "fork_boundary"` (`source: "btw" | "fork"`).
- **Per-agent state frames** (full-replacement snapshots per `(session_id, agent_id)`):
  - `agent`: `{ status: "idle" | "running" | "ended", compacting: boolean, model?, thinking?, permission_mode?: "manual" | "auto" | "yolo", plan_mode, swarm_mode, tower_mode }`
  - `context`: `{ context_tokens, max_context_tokens? }` (coalesced ~250 ms)
  - `goal`: `{ goal?: { objective, status, completion_criterion?, turns_used, tokens_used, wall_clock_ms } }` (`main` only)
  - `todo`: `{ items: { title, status: "pending" | "in_progress" | "done" }[] }`

---

## WebSocket and conversation reduction constitution

Machine schemas describe individual frame shapes, but reliable clients and orchestrators **must** implement the six runtime invariants below.

### 1. Heartbeat and command framing

- **Heartbeat**: Server sends `{ "type": "ping" }` every 10 s; reply `{ "type": "pong" }`. Connections silent for 20–30 s are closed by the server (`1001`). Reconnect if no frame arrives from the server within 25 s.
- **Commands**: Client commands (`subscribe`, `unsubscribe`, `task.watch`, `task.unwatch`, `task.stop`, `task.background`) require a non-empty `request_id` (omitting `request_id` closes the socket with `1008`) and receive `{ "type": "response", "request_id", "code", "msg?", "task?" }`.

### 2. Subscription sequence and session-wide interactions

Sending `{ "type": "subscribe", "request_id": "r1", "session_id": "s1", "agent_ids": ["main"] }` (`agent_ids` defaults to `["main"]`; sending `subscribe` again with `["sub_1"]` adds `sub_1` without re-sending `main`) emits frames in this guaranteed order:

1. `response` (`code: 0`, or non-zero such as `40401` / `40930` / `40931`).
2. All unresolved `interaction` frames (`status: "pending"`) across **every agent in the session** (`interaction` bypasses `agent_ids` so subagent approvals never block invisibly when only `main` is subscribed).
3. **Initial snapshots**: `task.list`, `agent`, `context`, `goal` (`main` only), `todo` for each newly added agent.
4. **`turns`** (latest ≤10 turns within 1 MiB, or `turns.failed`). **Live conversation frames (`turn.*`, `item.*`, `turns.removed`, `notice`) for an agent never arrive before its initial `turns` frame** — frames produced during disk load are buffered and flushed in order right after `turns`.

Canonical wire walkthrough (`C` = WS client → server, `S` = WS server → client, `H` = HTTP request, `R` = HTTP response `data`):

```text
C {"type": "subscribe", "request_id": "sub-1", "session_id": "s1", "agent_ids": ["main"]}
S {"type": "response", "request_id": "sub-1", "code": 0}
S {"type": "task.list", "session_id": "s1", "agent_id": "main", "tasks": []}
S {"type": "agent", "event_created_at": "2026-11-17T04:00:00.000Z", "session_id": "s1", "agent_id": "main", "status": "idle", "compacting": false, "model": "kimi-for-coding", "thinking": "high", "permission_mode": "manual", "plan_mode": false, "swarm_mode": false, "tower_mode": false}
S {"type": "goal", "event_created_at": "2026-11-17T04:00:00.000Z", "session_id": "s1", "agent_id": "main"}
S {"type": "todo", "event_created_at": "2026-11-17T04:00:00.000Z", "session_id": "s1", "agent_id": "main", "items": []}
S {"type": "turns", "event_created_at": "2026-11-17T04:00:00.000Z", "session_id": "s1", "agent_id": "main", "turns": [], "has_more": false}

H POST /api/v1/sessions/s1/prompts  {"prompt_id": "p-1", "content": [{"type": "text", "text": "Read README.md"}]}
R {"prompt_id": "p-1", "user_message_id": "u_1", "status": "running", "content": [{"type": "text", "text": "Read README.md"}], "created_at": "2026-11-17T04:00:01.000Z"}

S {"type": "agent", "event_created_at": "2026-11-17T04:00:01.000Z", "session_id": "s1", "agent_id": "main", "status": "running", "compacting": false, "model": "kimi-for-coding", "thinking": "high", "permission_mode": "manual", "plan_mode": false, "swarm_mode": false, "tower_mode": false}
S {"type": "turn.started", "event_created_at": "2026-11-17T04:00:01.000Z", "session_id": "s1", "agent_id": "main", "turn": {"turn_id": "t_1", "ordinal": 0, "turn_number": 0, "kind": "agent", "status": "running", "started_at": "2026-11-17T04:00:01.000Z", "steps": []}}
S {"type": "item.ended", "event_created_at": "2026-11-17T04:00:01.000Z", "session_id": "s1", "agent_id": "main", "turn_id": "t_1", "item": {"item_id": "u_1", "type": "user_message", "status": "ended", "outcome": "completed", "created_at": "2026-11-17T04:00:01.000Z", "prompt_ids": ["p-1"], "placement": "opener", "origin": {"kind": "user"}, "text": "Read README.md", "attachments": [], "skills": []}}
S {"type": "item.started", "event_created_at": "2026-11-17T04:00:01.300Z", "session_id": "s1", "agent_id": "main", "turn_id": "t_1", "item": {"item_id": "call_1", "type": "tool_call", "step_index": 1, "status": "running", "created_at": "2026-11-17T04:00:01.300Z", "name": "Read", "stage": "input", "input_text": "{\"path\":", "started_at": "2026-11-17T04:00:01.300Z"}}
S {"type": "item.delta", "event_created_at": "2026-11-17T04:00:01.350Z", "session_id": "s1", "agent_id": "main", "turn_id": "t_1", "item_id": "call_1", "field": "input_text", "delta": "\"README.md\"}"}
S {"type": "item.updated", "event_created_at": "2026-11-17T04:00:01.400Z", "session_id": "s1", "agent_id": "main", "turn_id": "t_1", "item_id": "call_1", "set": {"stage": "executing", "input": {"path": "README.md"}}}
S {"type": "item.ended", "event_created_at": "2026-11-17T04:00:01.450Z", "session_id": "s1", "agent_id": "main", "turn_id": "t_1", "item": {"item_id": "call_1", "type": "tool_call", "step_index": 1, "status": "ended", "outcome": "completed", "created_at": "2026-11-17T04:00:01.300Z", "name": "Read", "stage": "executing", "input": {"path": "README.md"}, "output": "1\t# App", "started_at": "2026-11-17T04:00:01.300Z", "ended_at": "2026-11-17T04:00:01.450Z"}}
S {"type": "turn.updated", "event_created_at": "2026-11-17T04:00:01.450Z", "session_id": "s1", "agent_id": "main", "turn_id": "t_1", "step": {"index": 1, "outcome": "completed", "finish_reason": "tool_use", "started_at": "2026-11-17T04:00:01.100Z", "ended_at": "2026-11-17T04:00:01.450Z"}}
S {"type": "item.started", "event_created_at": "2026-11-17T04:00:01.700Z", "session_id": "s1", "agent_id": "main", "turn_id": "t_1", "item": {"item_id": "a_1", "type": "assistant_message", "step_index": 2, "status": "running", "created_at": "2026-11-17T04:00:01.700Z", "text": "Done — "}}
S {"type": "item.delta", "event_created_at": "2026-11-17T04:00:01.750Z", "session_id": "s1", "agent_id": "main", "turn_id": "t_1", "item_id": "a_1", "field": "text", "delta": "README.md defines # App."}}
S {"type": "item.ended", "event_created_at": "2026-11-17T04:00:01.800Z", "session_id": "s1", "agent_id": "main", "turn_id": "t_1", "item": {"item_id": "a_1", "type": "assistant_message", "step_index": 2, "status": "ended", "outcome": "completed", "created_at": "2026-11-17T04:00:01.700Z", "text": "Done — README.md defines # App."}}
S {"type": "turn.updated", "event_created_at": "2026-11-17T04:00:01.800Z", "session_id": "s1", "agent_id": "main", "turn_id": "t_1", "step": {"index": 2, "outcome": "completed", "finish_reason": "end_turn", "started_at": "2026-11-17T04:00:01.500Z", "ended_at": "2026-11-17T04:00:01.800Z"}}
S {"type": "turn.ended", "event_created_at": "2026-11-17T04:00:01.800Z", "session_id": "s1", "agent_id": "main", "turn": {"turn_id": "t_1", "ordinal": 0, "turn_number": 0, "kind": "agent", "status": "ended", "outcome": "completed", "started_at": "2026-11-17T04:00:01.000Z", "ended_at": "2026-11-17T04:00:01.800Z", "duration_ms": 800, "steps": [{"index": 1, "outcome": "completed", "finish_reason": "tool_use", "started_at": "2026-11-17T04:00:01.100Z", "ended_at": "2026-11-17T04:00:01.450Z"}, {"index": 2, "outcome": "completed", "finish_reason": "end_turn", "started_at": "2026-11-17T04:00:01.500Z", "ended_at": "2026-11-17T04:00:01.800Z"}]}}
S {"type": "agent", "event_created_at": "2026-11-17T04:00:01.800Z", "session_id": "s1", "agent_id": "main", "status": "idle", "compacting": false, "model": "kimi-for-coding", "thinking": "high", "permission_mode": "manual", "plan_mode": false, "swarm_mode": false, "tower_mode": false}
```

### 3. Defensive `Turn` and `Item` reduction rules

Maintain turns per `(session_id, agent_id)` sorted by `ordinal`, and reduce frames defensively:

- **`turns` snapshot**: Replaces the latest turns for that agent (also re-sent automatically when an idle-reclaimed session reopens or `:reload` executes).
- **`turn.started` & `turn.ended` omit `items`**: `frame.turn` contains turn header fields only. Upsert the turn header by `turn_id` and **preserve your existing `turn.items` array**.
- **`turn.updated`**: Upsert `frame.step` into `turn.steps` by `step.index`; set `turn.retry = frame.retry` (when `frame.retry` is omitted, clear any active retry state).
- **`item.started` carries non-empty initial text (lazy start)**: The server emits `item.started` on the first content chunk, so **`item.started.item.text` (or `input_text`) is already non-empty**, and short replies frequently transition directly from `item.started` to `item.ended` with **zero** `item.delta` frames. Moreover, `tool_call` items start without an `output` field. Always apply:
  ```js
  // item.started / item.ended: upsert full item (item.ended is authoritative)
  itemsById.set(frame.item.item_id, { ...itemsById.get(frame.item.item_id), ...frame.item });

  // item.delta: nullish-safe string concatenation (field is "text" | "input_text" | "output")
  const item = itemsById.get(frame.item_id);
  if (item) item[frame.field] = (item[frame.field] ?? '') + frame.delta;

  // item.updated: shallow field patch (e.g. stage -> "awaiting_approval" | "executing")
  const target = itemsById.get(frame.item_id);
  if (target) Object.assign(target, frame.set);

  // item.removed: discard partial item before an LLM retry restarts the step
  itemsById.delete(frame.item_id);
  ```
- **`turns.removed`**: Delete all turns in `frame.turn_ids` (after `:undo` or context reset) and drop any in-flight `GET .../turns` responses requested prior to this frame.
- **Out-of-order interaction vs. tool item**: Because `interaction` flushes immediately while conversation frames batch on a 16 ms window, **`interaction` (`status: "pending"`) may arrive before `item.updated` (`stage: "awaiting_approval"`) or `item.started`**. Store pending interactions in a session-level map keyed by `interaction_id` rather than dropping interactions whose `tool_call_id` item is not yet in `turn.items`.

### 4. Prompts, `/steer` cross-turn behavior, and completion criteria

- **Submitting (`/prompts`)**: Starts immediately (`status: "running"`) when idle, or enters the queue (`status: "queued"`) when busy. Always pass a client-generated `prompt_id` (resending the same `prompt_id` + body is idempotent; reusing `prompt_id` with different content returns `40927`).
- **Real runtime behavior of `/steer` and `/prompts:steer`**:
  1. **Stream interruption & continuation `Turn`**: When a steer arrives while the model is streaming, the loop immediately interrupts the in-flight model step (`step.outcome = "interrupted"`). Depending on the step boundary, the engine either injects the message into the current turn (`placement: "steer"`) **or** finishes the current turn and immediately starts a **new continuation `Turn` (with a brand-new `turn_id`)** carrying your steered message as `placement: "opener"`.
  2. **Task-chain completion rule**: Orchestrators must **not** stop waiting on `turn.ended` of the initial `turn_id` alone. Treat work as finished only when: (a) all submitted `prompt_id`s have appeared in `user_message.prompt_ids`, **and** (b) `main`'s `agent` frame reports `status: "idle"` (`compacting: false`). (`turn.ended` is guaranteed to arrive before `agent` `status: "idle"`).
  3. **`POST /sessions/{id}/steer` blocks until injection — never block your WS loop**: Direct `POST .../steer` stays open until the agent reaches an injection point. If the agent is currently paused on a pending `interaction` (`approval` or `question`), it cannot reach an injection point until that interaction is answered. **Never `await fetch('/steer')` on the same coroutine/loop that processes WebSocket `interaction` frames**, or your client will deadlock! Handle WebSocket frames concurrently, or resolve pending interactions before calling `/steer`.
- **Stopping everything (`:cancel` vs. queued prompts)**: `POST /sessions/{id}:cancel` stops the running turn (and background tasks if `include_background: true`), **not** queued prompts. To clear queued work as well, call `POST /sessions/{id}/prompts/{prompt_id}:abort` on queued items first, then `:cancel`.
- **Undo (`:undo`), compaction (`:compact`), and side-chats (`:btw`)**:
  - `POST /sessions/{id}:undo` (`{ turn_id, agent_id? }`) removes `turn_id` and all later turns from history and broadcasts `turns.removed` (does not revert disk edits; returns `40911` across a prior compaction boundary or `40901` while busy).
  - `POST /sessions/{id}:compact` (`{ instruction? }`) runs manual context compaction when idle (`agent.compacting` flips `true` → emits a `system` compaction turn → flips `false`).
  - `POST /sessions/{id}:btw` spawns a read-only forked side-chat agent (`{ agent_id }`); subscribe incrementally with `agent_ids: [agent_id]` and send prompts targeting `agent_id`.

### 5. Approvals and questions (`interaction`)

Respond via `POST /api/v1/sessions/{session_id}/interactions/{interaction_id}`:

```text
S {"type": "interaction", "event_created_at": "2026-11-17T04:01:00.000Z", "session_id": "s1", "agent_id": "main", "interaction_id": "i9", "kind": "approval", "status": "pending", "tool_call_id": "c7", "request": {"tool_name": "Bash", "action": "Run command", "tool_input_display": {"command": "rm -rf dist"}, "expires_at": "2026-11-18T04:01:00.000Z"}}
H POST /api/v1/sessions/s1/interactions/i9  {"kind": "approval", "decision": "approved", "scope": "session"}
R {"outcome": "approved", "ended_at": "2026-11-17T04:01:02.000Z"}
S {"type": "interaction", "event_created_at": "2026-11-17T04:01:02.000Z", "session_id": "s1", "agent_id": "main", "interaction_id": "i9", "kind": "approval", "status": "ended", "outcome": "approved", "ended_at": "2026-11-17T04:01:02.000Z", "response": {"decision": "approved", "scope": "session"}, "request": {"tool_name": "Bash", "action": "Run command", "tool_input_display": {"command": "rm -rf dist"}, "expires_at": "2026-11-18T04:01:00.000Z"}}

S {"type": "interaction", "event_created_at": "2026-11-17T04:01:10.000Z", "session_id": "s1", "agent_id": "main", "interaction_id": "i10", "kind": "question", "status": "pending", "tool_call_id": "c8", "request": {"questions": [{"id": "q1", "question": "Package manager?", "multi_select": false, "allow_other": true, "options": [{"id": "a", "label": "pnpm"}, {"id": "b", "label": "npm"}]}]}}
H POST /api/v1/sessions/s1/interactions/i10  {"kind": "question", "answers": {"q1": {"kind": "single", "option_id": "a"}}}
R {"outcome": "answered", "ended_at": "2026-11-17T04:01:12.000Z"}
```

- **Approval** (`kind: "approval"`): `{ "kind": "approval", "decision": "approved" | "rejected" | "cancelled", "scope"?: "session", "feedback"?: "..." }`. Omit `scope` for one-time approval; set `"scope": "session"` to approve matching actions for the rest of the session.
- **Question** (`kind: "question"`): `{ "kind": "question", "answers": { "<question_id>": { "kind": "single", "option_id": "..." } } }` (also supports `{ "kind": "multi", "option_ids": [...] }`, `{ "kind": "other", "text": "..." }`, `{ "kind": "multi_with_other", "option_ids": [...], "other_text": "..." }`, `{ "kind": "skipped" }`), **or** `{ "kind": "question", "dismissed": true }` when an unattended orchestrator has no human operator available (prevents hanging the turn).
- **Close UI on WS `status: "ended"`**: Wait for the `interaction` frame with `status: "ended"` to dismiss UI prompts so multiple windows stay synchronized; treat HTTP `40902` (already ended) and `40404` (evicted) as benign races.

### 6. Task output (`task.watch`), reconnection, and global events

```text
S {"type": "task", "event_created_at": "2026-11-17T04:02:00.000Z", "session_id": "s1", "agent_id": "main", "task_id": "bash-k3f9", "kind": "shell", "status": "running", "detached": true, "description": "Dev server", "command": "pnpm dev", "started_at": "2026-11-17T04:02:00.000Z"}
C {"type": "task.watch", "request_id": "w1", "session_id": "s1", "agent_id": "main", "task_id": "bash-k3f9"}
S {"type": "response", "request_id": "w1", "code": 0, "task": {"task_id": "bash-k3f9", "kind": "shell", "status": "running", "detached": true}}
S {"type": "task.output", "session_id": "s1", "agent_id": "main", "task_id": "bash-k3f9", "offset": 0, "text": "VITE ready\n"}
C {"type": "task.stop", "request_id": "s1-stop", "session_id": "s1", "agent_id": "main", "task_id": "bash-k3f9"}
S {"type": "response", "request_id": "s1-stop", "code": 0, "task": {"task_id": "bash-k3f9", "kind": "shell", "status": "ended", "outcome": "killed", "detached": true}}
```

- **UTF-8 byte offsets in `task.output`**: `task.output` carries `{ session_id, agent_id, task_id, offset, text }` where `offset` is a **UTF-8 byte offset** (not JS string `.length`). Maintain `endOffset = offset + Buffer.byteLength(text, 'utf8')`. When re-watching with `since_offset: endOffset`, append `text` if `chunk.offset === endOffset`, otherwise replace your buffer starting at `chunk.offset`.
- **Reconnection**: Subscriptions and `task.watch` streams are connection-scoped. After reconnecting: (1) resend `subscribe` and replace local session state from the fresh snapshots, (2) resend `task.watch` with `since_offset`, and (3) re-fetch REST lists (`GET /api/v1/sessions`, etc.).
- **Global events**: Sent flat to all connections without subscription: `session` (`change`: `created`/`updated`/`archived`/`restored`/`deleted`), `workspace` (`change`), `config`, `invalidated` (`kind`: `models`/`plugins` → refetch REST endpoint), `event.capability.changed`, and `event.access.request` (`owner` connections only). Changes made on disk by external CLI processes reconcile every ~60 s without WS broadcasts; dashboards should poll `GET /api/v1/sessions` at low frequency (~60 s or on focus).

### 7. Common pitfalls checklist (verified in agent dogfooding)

- **Never parse human startup banners or read `~/.kimi-code/server.token`**: Spawn `kimi web --port 0 --json` and parse line 1 of `stdout`, or use `/api/v1/access/requests` / `kimi access create` against a running server.
- **Check `meta.capabilities` instead of `server_version`**: Feature availability across versions is exposed as booleans on `GET /api/v1/meta` → `data.capabilities`.
- **Do not overwrite `turn.items` on `turn.ended`**: `turn.started` and `turn.ended` omit `items`; only merge header properties.
- **Do not assume `item.started` has empty `text` / `input_text`**: Initial chunks arrive inside `item.started.item`; short responses emit zero `item.delta` frames. Always use `(item[field] ?? '') + delta` on `item.delta`.
- **Do not stop waiting on the initial `turn_id`'s `turn.ended` when steering**: Mid-stream `/steer` can interrupt the current turn and open a new continuation `Turn`; wait until all submitted `prompt_id`s are consumed **and** `agent.status === "idle"`.
- **Never block your WebSocket loop awaiting `POST /steer`**: Direct `/steer` blocks until an injection point, which stalls forever if an `interaction` approval arrives and nobody reads the WebSocket to approve it.

---

## Complete endpoint and WebSocket catalog

Fetch `GET /openapi.json` and `GET /asyncapi.json` for exact parameter and payload schemas. In **Gate**, `baseline` means guaranteed in KAP `0.1.0`; capability names refer to boolean flags in `GET /api/v1/meta` → `data.capabilities.<flag>`.

### Metadata, schemas & access control

| Method & Path | Min Role | Gate | Summary |
| --- | --- | --- | --- |
| `GET /api/v1/healthz` | `public` | `baseline` | Unauthenticated liveness probe (`{ ok: true }`) |
| `GET /openapi.json` | `viewer` | `baseline` | Raw OpenAPI 3.0 specification for public `/api/v1` routes |
| `GET /asyncapi.json` | `viewer` | `baseline` | Raw AsyncAPI 3.1 specification for `/api/v1/ws` frames |
| `GET /api/v1/meta` | `viewer` | `baseline` | Protocol version, `server_version`, `server_id`, `capabilities`, `experimental_flags`, active `features` |
| `GET /api/v1/access/me` | `viewer` | `access_tokens` | Caller's resolved `{ role, principal_id?, name? }` |
| `POST /api/v1/access/requests` | `public` | `access_tokens` | Start local passwordless access handshake (Origin-checked & rate-limited) |
| `POST /api/v1/access/requests/{id}:exchange` | `public` | `access_tokens` | Poll or claim `{ status, token, role, principal_id }` once using `device_code` |
| `POST /api/v1/access/requests/{id}:resolve` | `owner` | `access_tokens` | Approve or reject a pending access request |
| `GET /api/v1/access/principals` | `owner` | `access_tokens` | List issued external token principals (`access_tokens.json`) |
| `DELETE /api/v1/access/principals/{principal_id}` | `owner` | `access_tokens` | Revoke an external token principal and close its active WebSocket connections |
| `POST /api/v1/shutdown` | `owner` | `baseline` | Gracefully shut down the server (loopback by default) |

### Sessions, turns, prompts, skills & interactions

| Method & Path | Min Role | Gate | Summary |
| --- | --- | --- | --- |
| `POST /api/v1/sessions` | `operator` | `baseline` | Create a session (`cwd` or `workspace_id`, optional `title`, `metadata`, `agent_config`, `environment_id`) |
| `GET /api/v1/sessions` | `viewer` | `baseline` | List/filter/group sessions (`flat` or `by_workspace`, `include=git`, `fields=id,archived`, pagination) |
| `GET /api/v1/sessions/{session_id}` | `viewer` | `baseline` | Get one session object |
| `POST /api/v1/sessions/{session_id}/profile` | `operator` | `baseline` | Update `title`, `metadata`, or main `agent_config` (`model`, `thinking`, `permission_mode`, `plan_mode`, `swarm_mode`, `tower_mode`, `goal`) |
| `POST /api/v1/sessions/{session_id}/title/generate` | `operator` | `baseline` | Generate a session title from conversation context |
| `POST /api/v1/sessions:archive` / `:restore` | `operator` | `baseline` | Batch archive or restore sessions by `ids` |
| `POST /api/v1/sessions/{session_id}:archive` / `:delete` | `operator` | `baseline` | Archive or permanently delete one session |
| `POST /api/v1/sessions/{session_id}:cancel` | `operator` | `baseline` | Cancel running turn (`agent_id?`, `include_background?`) |
| `POST /api/v1/sessions/{session_id}:fork` | `operator` | `baseline` | Fork session up to optional `turn_index` into a new session |
| `POST /api/v1/sessions/{session_id}:undo` | `operator` | `baseline` | Remove `turn_id` and subsequent turns from conversation history |
| `POST /api/v1/sessions/{session_id}:compact` | `operator` | `baseline` | Trigger manual context compaction (`instruction?`) |
| `POST /api/v1/sessions/{session_id}:btw` | `operator` | `baseline` | Spawn a read-only side-chat agent (`agent_id`) forked from current context |
| `POST /api/v1/sessions/{session_id}:reload` | `operator` | `baseline` | Close and reload in-memory session state from disk |
| `POST /api/v1/sessions/{session_id}:takeover` | `operator` | `baseline` | Break a stale cross-process session lock (`40931`) |
| `POST /api/v1/sessions/{session_id}/export` | `operator` | `baseline` | Export session archive as ZIP |
| `GET /api/v1/sessions/{session_id}/warnings` | `viewer` | `baseline` | List active session diagnostics/warnings |
| `GET /api/v1/sessions/{session_id}/environment` / `/environments` | `viewer` | `baseline` | Read bound execution environment and available environments |
| `POST /api/v1/sessions/{session_id}/rating` | `operator` | `baseline` | Evaluate or submit session feedback survey |
| `GET /api/v1/sessions/{session_id}/agents/{agent_id}/turns` | `viewer` | `baseline` | Paginate historical `Turn` objects backward via `before_ordinal` |
| `GET /api/v1/sessions/{session_id}/prompts` | `viewer` | `baseline` | Read active and queued prompts for `main` |
| `POST /api/v1/sessions/{session_id}/prompts` | `operator` | `baseline` | Submit user prompt (`prompt_id`, `content`, `agent_id?`, per-turn overrides, `skills?`) |
| `POST /api/v1/sessions/{session_id}/steer` | `operator` | `baseline` | Directly steer a prompt into a running turn (blocks until injected) |
| `POST /api/v1/sessions/{session_id}/prompts:steer` | `operator` | `baseline` | Convert queued `prompt_ids` into mid-turn steers |
| `POST /api/v1/sessions/{session_id}/prompts/{prompt_id}:abort` | `operator` | `baseline` | Withdraw a queued prompt before execution |
| `POST /api/v1/sessions/{session_id}/interactions/{interaction_id}` | `operator` | `baseline` | Answer a pending `approval` or `question` interaction |
| `GET /api/v1/sessions/{session_id}/skills` | `viewer` | `baseline` | List skills available to the session |
| `POST /api/v1/sessions/{session_id}/skills/{name}:activate` | `operator` | `baseline` | Invoke a skill as a prompt submission |
| `GET /api/v1/sessions/{session_id}/file-history/changes` & `/content` | `viewer` | `baseline` | Inspect per-turn file diffs and historical file snapshots |

### Files, uploads, workspaces & search

| Method & Path | Min Role | Gate | Summary |
| --- | --- | --- | --- |
| `POST /api/v1/files` | `operator` | `file_upload` | Upload attachment (`multipart/form-data`), returns `{ id, name, media_type, size }` |
| `GET /api/v1/files/{file_id}` / `DELETE /api/v1/files/{file_id}` | `viewer` / `operator` | `file_upload` | Download (`Range`/`ETag`) or delete an uploaded attachment |
| `GET /api/v1/sessions/{session_id}/media/{file_id}` | `viewer` | `baseline` | Download persisted session media blob |
| `POST /api/v1/sessions/{session_id}/fs:{action}` | `operator` | `fs_query` | Session-scoped fs actions: `list`, `read`, `list_many`, `stat`, `stat_many`, `mkdir`, `search`, `grep`, `git_status`, `git_status:batch`, `pull_request`, `pull_request:batch`, `diff`, `open`, `open-in`, `reveal` |
| `GET /api/v1/sessions/{session_id}/fs/{path}:download` | `viewer` | `fs_query` | Download file inside session workspace (`Range`/`ETag`) |
| `POST /api/v1/workspace/fs:list` / `:search` / `:suggest` | `operator` | `fs_query` | Workspace-scoped fs queries without a session (`operator` restricted to registered `workspace_id`; `owner` may also pass an absolute root) |
| `GET /api/v1/fs:browse` / `:home` / `:content` & `POST /api/v1/fs:mkdir` / `:suggest` | `owner` | `fs_query` | Host-wide folder picker and arbitrary host file reader (`owner` only) |
| `POST /api/v1/search` | `operator` | `baseline` | Full-text search across session messages |
| `GET /api/v1/workspaces` & `GET /api/v1/workspaces/{id}/trust` & `/skills` | `viewer` | `baseline` | List registered workspaces, workspace trust status, and workspace skills |
| `POST` / `PATCH` / `DELETE /api/v1/workspaces*` & `GET .../project-config-dirs` | `owner` | `baseline` | Register, rename, delete, set primary dir, or change trust of workspaces (`owner` only) |

### Models, providers, config, tools, capabilities, plugins, MCP & OAuth

| Method & Path | Min Role | Gate | Summary |
| --- | --- | --- | --- |
| `GET /api/v1/auth` | `viewer` | `baseline` | Auth & model readiness summary |
| `GET /api/v1/models` & `GET /api/v1/providers` & `/providers/{id}` & `/catalog/providers*` | `viewer` | `baseline` | List configured model aliases, configured providers (redacted), and `models.dev` catalog |
| `POST /api/v1/models/{id}:set_default` & `POST`/`PUT`/`DELETE /api/v1/providers*` | `owner` | `baseline` | Set default model or create/update/delete/import/refresh providers (`owner` only) |
| `GET /api/v1/config` / `POST /api/v1/config` | `viewer` / `owner` | `baseline` | Read redacted global config (`viewer+`) or merge-patch global config (`owner` only) |
| `GET /api/v1/tools` | `viewer` | `baseline` | List registered agent tools |
| `GET /api/v1/capabilities` & `/capabilities/{id}` / `POST /api/v1/capabilities/{id}:install` | `viewer` / `owner` | `baseline` | Inspect built-in capabilities (`viewer+`) or trigger install (`owner` only) |
| `GET /api/v1/plugins` & `/plugins/marketplace` & `/plugins/{id}` / `POST /api/v1/plugins*` | `viewer` / `owner` | `baseline` | Read installed/marketplace plugins (`viewer+`) or preview/install/enable/disable/remove (`owner` only) |
| `GET /api/v1/mcp/servers*` & `/mcp/auth-statuses` / `POST`/`PUT`/`DELETE /api/v1/mcp/*` | `viewer` / `owner` | `mcp` | Read MCP servers & auth statuses (`viewer+`) or mutate/test/inspect/OAuth global MCP servers (`owner` only) |
| `GET /api/v1/oauth/usage` & `/oauth/userinfo` & `/oauth/region` | `viewer` | `baseline` | Read managed account quota, profile, and region |
| `GET`/`POST`/`DELETE /api/v1/oauth/login` & `POST /api/v1/oauth/logout` | `owner` | `baseline` | Start/poll/cancel OAuth login or log out (`owner` only) |
| `GET`/`POST`/`PATCH`/`DELETE /api/v1/remote-control*` | `owner` | `baseline` | Manage Kimi Remote Control tunnel and paired devices (`owner` only) |

### WebSocket `/api/v1/ws` frames

| Direction | `type` | Min Role | Gate | Summary |
| --- | --- | --- | --- | --- |
| C → S | `subscribe` / `unsubscribe` | `viewer` | `websocket` | Subscribe or unsubscribe `(session_id, agent_ids?)` |
| C → S | `task.watch` / `task.unwatch` | `viewer` | `tasks` | Start or stop streaming UTF-8 task output (`since_offset?`, `tail_bytes?`) |
| C → S | `task.stop` / `task.background` | `operator` | `tasks` | Kill a running task or detach a foreground tool call to background |
| C ↔ S | `ping` (S → C) / `pong` (C → S) | `viewer` | `websocket` | 10 s server heartbeat and client reply |
| S → C | `response` | `viewer` | `websocket` | Reply to client command matched by `request_id` (`code`, `msg?`, `task?`) |
| S → C | `turns` / `turns.failed` / `turns.removed` | `viewer` | `websocket` | Initial/reloaded turn page, load failure, or removed `turn_ids` |
| S → C | `turn` (`turn.started` / `turn.ended`) & `turn.updated` | `viewer` | `websocket` | Turn header lifecycle (omits `items`) and step/retry updates |
| S → C | `item` (`item.started` / `item.ended`), `item.delta`, `item.updated`, `item.removed` | `viewer` | `websocket` | Streaming item lifecycle (`item.started` carries initial non-empty text) |
| S → C | `notice` | `viewer` | `websocket` | Transient agent warning/notice (not persisted in turns) |
| S → C | `interaction` | `viewer` | `websocket` | Session-wide `pending` or `ended` approval/question state |
| S → C | `agent` / `context` / `goal` / `todo` | `viewer` | `websocket` | Per-agent status/settings, token water-level, main goal, and todo list |
| S → C | `task.list` / `task` / `task.output` | `viewer` | `tasks` | Running task snapshot, single task state update, and byte-offset output chunk |
| S → C | `session` / `workspace` / `config` / `invalidated` / `event.capability.changed` | `viewer` | `websocket` | Unsubscribed global state broadcasts |
| S → C | `event.access.request` | `owner` | `access_tokens` | Pending/resolved local client access request (`owner` connections only) |

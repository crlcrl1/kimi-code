# kap-server Agent Guide

`@moonshot-ai/kap-server` exposes the Kimi Agent Protocol (KAP) over `/api/v1` REST and `/api/v1/ws` WebSocket. In addition to first-party Desktop and Web clients, external third-party KAP clients and multi-agent orchestrators consume `/api/v1` across differing Kimi Code versions.

## Hard Rules

### 1. `/api/v1` Additive-Only Evolution & Behavioral Stability

- **Shape is additive-only**: Never remove or rename a published route, query/body parameter, response field, or WebSocket frame/event field, and never turn an optional request field into a required one. Avoid custom protocol version headers (`X-KAP-Version`) or parallel version-translation layers.
- **Default behavior stays stable**: Omitting newly added parameters on an existing route or WebSocket command must preserve the established default behavior. Gate new behaviors behind optional parameters (for example `include_background` on `:cancel`) or new action suffixes.
- **Advertise incremental capabilities via `GET /api/v1/meta`**: Third-party clients discover optional protocol features through boolean flags on `meta.capabilities` rather than parsing `server_version`. Keep the OpenAPI / AsyncAPI contract snapshot tests green when adding surface area.

### 2. Wire Naming & Internal-Only Route Hiding

- **Public wire fields use `snake_case`**: Request bodies, query strings, response `data` payloads, and WebSocket frames use `snake_case` field names (explicitly documented passthrough payloads such as raw config keys or external metadata maps are the only exceptions).
- **Hide first-party internal endpoints**: Routes intended strictly for first-party host internals or test harnesses (such as `/client-configs/*` and `/debug/*`) must set `hide: true` on their route schema so they never leak into `/openapi.json` or `docs/kap.md`.

### 3. New Route / WebSocket Command Checklist (Three-Part Rule)

Whenever you add or modify an HTTP route under `src/routes/` or a WebSocket operation under `src/transport/ws/v1/` and `src/protocol/`:

1. **Declare minimum role (`minRole`)**: Explicitly set `minRole` (`'viewer' | 'operator' | 'owner'`, or `'public'` only for explicitly rate-limited and Origin-checked bootstrap endpoints). Keep privileges minimal — never expose arbitrary host filesystem paths (`/fs:content`, `/fs:browse`, `/fs:home`, `/fs:mkdir`, `/fs:suggest`), global config/provider/plugin/MCP mutations, `/oauth/*` mutations, `/remote-control`, `/shutdown`, or `/access/principals*` to `operator` or `viewer`. Unauthorized role access must return `403` with error code `40302` (`ACCESS_FORBIDDEN`).
2. **Expose `meta.capabilities` when appropriate**: If third-party clients need to detect whether a running server supports the new capability before calling it, add a boolean capability flag to `metaCapabilitiesSchema` (`src/protocol/rest-meta.ts`) and `src/routes/meta.ts`.
3. **Sync `docs/kap.md`**: Update the endpoint / WebSocket catalog index in `packages/kap-server/docs/kap.md` (and `docs/{en,zh}/guides/kap.md` when user-facing connection or workflow guidance changes). Keep `docs/kap.md` concise and behavioral — field-level schemas belong in live `/openapi.json` and `/asyncapi.json`, not hand-copied parameter tables.

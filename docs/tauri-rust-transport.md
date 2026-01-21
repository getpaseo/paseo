# Tauri desktop: Rust-owned transport for daemon WebSocket

## Context

The desktop app is a Tauri wrapper that loads the web frontend. In production the WebView origin is `tauri://localhost`, so connecting from the WebView with a browser `WebSocket` causes the daemon to see an `Origin: tauri://localhost` header and reject unless we add it to the daemon allow list. Allow-listing `tauri://localhost` is undesirable because it widens what can talk to the daemon from “this app’s WebView” to “any Tauri WebView”.

## Goal

Replace “WebView owns the WebSocket” with “Rust owns the socket; JS uses IPC”, without changing the daemon protocol (still the existing `/ws` JSON messages used by `DaemonClientV2`).

## Option A (recommended): Use the official Tauri v2 WebSocket plugin

Tauri provides an official plugin that opens a WebSocket using a Rust client, but exposes it to JavaScript:

- Rust: `tauri-plugin-websocket`
- JS: `@tauri-apps/plugin-websocket`

This removes the WebView’s `Origin` header entirely (native Rust client), so the daemon accepts the connection via its existing rule: `!origin || allowedOrigins.has(origin)`.

### JS integration shape (daemon client v2)

`DaemonClientV2` already supports arbitrary transports via `transportFactory?: DaemonTransportFactory`.

Add a small adapter that implements `DaemonTransportFactory` using `@tauri-apps/plugin-websocket`:

- Create connection async via `WebSocket.connect(url, { headers })`
- `transport.onOpen`: fire after `connect()` resolves
- `transport.onMessage`: subscribe via `ws.addListener`, forward only `Text` messages as `string` (or `{ data: string }` to match browser `MessageEvent`)
- `transport.onClose`: fire on `MessageKind<'Close', ...>` and also on explicit `disconnect()`
- `transport.onError`: fire on connection/send errors
- `transport.send`: `ws.send(string)` (queue until connected if needed)
- `transport.close`: `ws.disconnect()`

Then, in the app’s `useDaemonClient(url)` hook, detect Tauri and pass `transportFactory` so desktop automatically uses the Rust client, while web/mobile keep using the standard browser/native WebSocket.

### Tauri capability/permissions

Enable the websocket plugin permission(s) in `packages/desktop/src-tauri/capabilities/*.json` (at minimum `websocket:default`).

If you want stricter policy than “any WS URL”, prefer a scoped permission that only allows:

- `ws://localhost:*` / `ws://127.0.0.1:*` (and optionally LAN/private ranges if required)
- `wss://relay.paseo.sh` if the desktop app ever needs relay

(Exact scope syntax depends on the plugin permission schema; wire it up to match your allowed daemon URLs.)

## Option B: Custom Rust-managed transport (if you need tighter control)

If you want to ensure *JS cannot open arbitrary sockets even if compromised*, implement a small Rust module/plugin inside `packages/desktop/src-tauri` that:

- Owns all outbound connections to the daemon
- Enforces a URL policy in Rust (e.g. only localhost, or a persisted allowlist)
- Exposes only high-level IPC:
  - `daemon_connect({ url, headers? }) -> connectionId`
  - `daemon_send({ connectionId, data })`
  - `daemon_disconnect({ connectionId, code?, reason? })`
  - emits events:
    - `daemon://open`
    - `daemon://message`
    - `daemon://close`
    - `daemon://error`

On Rust side:

- Use `tokio-tungstenite` (or similar) + `tokio` tasks
- Store per-connection state in `tauri::State` (map `connectionId -> sender/handle`)
- Forward inbound text frames to the window via `window.emit(...)`
- Apply backpressure / queue limits (avoid unbounded memory if the UI stalls)

On JS side:

- Implement `DaemonTransportFactory` that wraps those commands/events, matching the same contract as Option A.

This option is more code than the official plugin, but it gives you a stronger security boundary: the WebView never gets a general-purpose “connect to any URL” capability.

## Verification (acceptance)

- Desktop build connects to a local daemon without adding `tauri://localhost` to daemon origin allow list.
- Existing `DaemonClientV2` session flow works unchanged (connect, send, receive, reconnect).
- Transport failures surface through the existing connection state/error UI.

## Open questions

- Do we need desktop to connect to **remote** daemons (LAN / public), or only localhost?
- Do we rely on WS **headers** (auth) today or soon?
- Is the daemon expected to be “browser-safe” or do we accept that *any local process* can connect (origin checks don’t stop native clients either)?

# Port Forwarding (TCP tunnel)

Paseo can forward a dev-server port from a **remote** daemon host to the client and open it at
`http://localhost:<port>` — the in-product equivalent of `ssh -L <port>:localhost:<port>`. It rides
the daemon WebSocket the client already holds; there is no second connection, no DNS, no reverse
proxy, and no requirement that the dev server bind `0.0.0.0` or that any firewall port be open.

The point is **localhost fidelity**. Reaching a remote dev server at `http://<host>:<port>` breaks
flows that assume `localhost` — most importantly OAuth (Google/Microsoft only allow `http://` redirect
URIs for `localhost`/`127.0.0.1`). Forwarding the same port to the client's own loopback makes the
browser's origin genuinely `localhost:<port>`, so registered callbacks and absolute redirect URLs line
up with zero app or provider-dashboard changes. Use the **same** local port as the remote port for this
to hold.

Contrast with the [service proxy](service-proxy.md): that exposes services at `*.localhost` /
public hostnames **on the daemon host**; this brings a port **to the client** as real localhost.

## Scope

- **Desktop (Electron) only.** It needs a main-process loopback TCP listener, which plain web and
  React Native can't provide, and the in-app browser is desktop-only anyway.
- **Driven off `paseo.json` `"type": "service"` scripts.** The port comes from the script's
  `WorkspaceScriptPayload.port`. There is no ad-hoc "forward an arbitrary port" entry point — declare
  the port as a service.
- **Activates only when the connection is remote** (relay, or direct TCP to a non-loopback host) and
  the daemon advertises the capability. Local connections (loopback TCP, unix socket, named pipe)
  already reach the service directly and are left unchanged.

## User flow

Opening a running service's link in the workspace scripts menu (the existing in-app-browser open
path, honoring the ask/in-app/external setting) lazily ensures a forward for that service's port and
opens `http://localhost:<port>` instead of the remote/proxy URL. Forwards are created on first open
and reused; they live until the app quits. If the local port can't be bound (already in use), the open
falls back to the direct/proxy URL.

## Data path

```
browser ⇄ Electron main loopback listener      (IPC: paseo:event:tunnel + *_tunnel_* commands, base64)
        ⇄ renderer tunnel controller            (packages/app/src/runtime/tunnel-forwarding.ts)
        ⇄ daemon client tunnel binary frames     (the existing daemon WebSocket)
        ⇄ daemon TunnelForwarder                 (packages/server/src/server/tunnel-forwarder.ts)
        ⇄ net.connect 127.0.0.1:<port>           (the dev server, on the daemon host)
```

Each browser connection to the local listener is one **stream**, identified by a string `streamId`
allocated by Electron main. The renderer maps the listener (and thus the daemon client + port) and
relays bytes; the daemon dials loopback and pipes both ways.

## Protocol

Everything rides the binary-frame channel (`packages/protocol/src/binary-frames/tunnel.ts`), alongside
the terminal and file-transfer families. Opcodes are in the `0x20` range:

| Opcode         | Dir             | Body        | Meaning                                   |
| -------------- | --------------- | ----------- | ----------------------------------------- |
| `Open` `0x22`  | client → daemon | uint16 port | open a stream to `127.0.0.1:<port>`       |
| `Data` `0x20`  | both            | raw bytes   | TCP payload for a stream                  |
| `Close` `0x21` | both            | reason byte | stream ended (`Normal` / `ConnectFailed`) |

Wire layout mirrors file-transfer: `[opcode][streamIdLen][streamId…][body…]`. There are **no** JSON RPC
messages — only a capability flag.

## Capability gating (COMPAT)

The daemon advertises `server_info.features.tcpTunnel`. The client tunnels **only** when it's `true`;
otherwise it opens the direct/proxy URL (the pre-existing behavior — not a degraded tunnel). The flag is
tagged `COMPAT(tcpTunnel)` in `packages/protocol/src/messages.ts` and set in
`packages/server/src/server/websocket-server.ts`. Old clients/daemons never exchange tunnel frames; an
unknown `0x20`-`0x22` opcode decodes to `null` and is ignored, so the change is backward-compatible.

## Security

The daemon **only ever connects to `127.0.0.1`** — the client supplies a port, never a host — so the
forwarder can't become an open proxy to arbitrary destinations. An authenticated client can already run
shells on the daemon host, so a loopback connect is well within the existing trust boundary.

## Backpressure & lifecycle

- **daemon → client** is gated: when the client's send buffer passes ~4 MB the upstream socket is
  paused and resumed when it drains (mirrors the terminal pipeline's `MAX_CLIENT_BUFFERED_BYTES`). A
  `null` buffered reading (e.g. the multiplexed relay socket) disables pausing — dropping bytes isn't an
  option for a TCP forward.
- **client → daemon** (uploads) currently relies on Node's socket buffering; there's no explicit
  watermark on that direction yet.
- Streams are torn down on either side's EOF/close; `TunnelForwarder.dispose()` (called from
  `Session.cleanup()` on disconnect) destroys all sockets, and `closeAllTunnelListeners()` runs on app
  quit.

## Known limitations (v1)

- Forwards are created lazily and reused; they're reclaimed when the window closes/reloads
  (`beforeunload`) or at app quit, not per in-app browser tab.
- Two windows forwarding the **same** remote port can't both bind it locally; the second falls back to
  the direct URL (its in-app browser then sees a non-localhost origin).
- No browser→daemon backpressure watermark on the upload direction (see above); loopback upstreams
  normally drain at memory speed.
- A daemon WebSocket outage longer than the ~90s session-resume grace window tears down the daemon's
  forwarder; browser connections held open across that gap stall rather than reset (open a new one).

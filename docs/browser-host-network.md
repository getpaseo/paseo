# Browser host network

On Paseo Desktop, a browser tab that belongs to a remote host can reach the web through that host's network. DNS resolves on the host, TCP connections open from the host's daemon, and `localhost` is the host's loopback. It works over any transport, including the E2E relay. The option is per host, off by default, desktop only.

For the user-facing description see [public-docs/browser.md](../public-docs/browser.md). For the profile and webview ownership around it see [architecture.md](architecture.md).

## Design

```text
tab (webview, partition persist:paseo-browser-via-<hash of serverId>)
  `-- session.setProxy -> http://127.0.0.1:<ephemeral port>   (desktop main)
        local HTTP proxy, Basic credential generated per run
          `-- IPC to the renderer that owns the host's DaemonClient
                `-- DaemonClient: network tunnel (owned subscription)
                      `-- the existing WebSocket, relay included
                            `-- daemon: DNS + policy + net.connect
```

The proxy hands the tunnel a `{host, port}` and nothing else. A hostname is never resolved on the desktop.

## Decisions

**One Electron session per routed host.** Chromium's proxy setting belongs to a session, and the web's site model keys on the hostname. `localhost:3000` on two hosts are two unrelated sites that share an origin string, so they must not share cookies, storage, or cache. A host with the option off keeps using the shared `persist:paseo-browser` session. The partition name must not match `LEGACY_BROWSER_ID_PATTERN` in `packages/desktop/src/features/browser-profile.ts`.

**HTTP proxy with a credential, not SOCKS5.** The tunnel reaches everything the host reaches, including its loopback (dev servers, databases, admin panels). Chromium only offers the no-auth method in a SOCKS5 greeting, so any local process, or another user on the machine, that finds the ephemeral port would inherit that access. An HTTP proxy lets the guest answer a `407` with a credential that exists only in the main process memory. This follows the rule in [permissions.md](permissions.md) that new authority is not granted silently.

**The tunnel is an owned subscription.** A v0.8+ client drops any daemon binary frame that does not belong to a registered subscription (`permitsBinary`, `packages/server/src/server/session/owned-subscriptions/index.ts:388`). Broadcasting tunnel frames, as the closed upstream attempt did, is discarded without an error. Opening the tunnel by JSON RPC and emitting frames through the subscription's owner also gives you cleanup for free: when the socket detaches, the daemon stops the tunnel.

**Credit is returned only after the final consumer wrote.** A relay socket has no backpressure, so each stream carries a credit window per direction. The receiver sends `WindowUpdate` for bytes the last hop finished writing, not for bytes it received. That rule holds at all three hops (daemon to client, client to desktop main, main to the Chromium socket). Counting a byte as consumed on receipt moves the queue into the IPC channel, where nothing bounds it. The window is one budget across every buffer of the bridge, not one window per hop. Frame layout, limits, and close reasons are in `packages/protocol/src/binary-frames/tunnel.ts` and `packages/protocol/src/network-tunnel/rpc-schemas.ts`.

**The daemon decides where it dials.** It resolves the name, checks every answer, and connects to the approved IP, so a second lookup cannot rebind the name. A name that mixes approved and denied answers is denied. Cloud metadata and link-local ranges are refused (`169.254.0.0/16`, `fe80::/10`, `fd00:ec2::254`, and `100.100.100.200`). IPv4-mapped, IPv4-compatible, SIIT, NAT64 (`64:ff9b::/96` and `64:ff9b:1::/48`), and 6to4 (`2002::/16`) addresses are checked against the embedded IPv4 address. Loopback and private ranges deliberately stay reachable so routed tabs can access host-local development servers and internal sites. The policy lives in `packages/server/src/server/network-tunnel/target-policy.ts`.

**Permission `network.proxy`.** Opening the tunnel, closing it, and every frame check it, so a revoke takes effect on streams already open. `tunnel.manage` covers relay and Hub relationships and does not authorize this egress. The owner preset receives it; existing operator, viewer, and Hub grants do not widen.

**Old clients.** The permission enum is closed in older clients, and one unknown value rejects the whole `server_info`. The daemon omits `network.proxy` from `server_info.permissions` and from the `hub.management.daemon.*` status payloads for clients that did not advertise `network_tunnel`. The feature itself is gated once on `server_info.features.networkTunnel`; an older host shows the option as unavailable with an update notice, with no fallback. Find every projection and gate with `rg "COMPAT\(networkTunnel\)"`.

**The option lives in desktop settings, keyed by `serverId`.** Do not add it to the host registry or to the persisted browser record. Both are strict schemas (`StoredHostProfileSchema` at `packages/app/src/types/host-connection.ts:434`, `BrowserRecordSchema` at `packages/app/src/desktop/browser/store/state.ts:37`). An older app that meets one unknown key rejects the whole collection, so it loses every saved host or every saved tab. The partition is derived from the current option when the webview is created, not stored on the tab.

## Gotchas measured in the spike and the reviews

- **Warm the credential.** If a WebSocket is the first connection a session makes through the proxy, Chromium gets the `407`, never raises `login`, and the socket fails. After `setProxy`, after app restart, and after `clearAuthCache()`, make one request with `net.request({ session })` that answers `login`. "Clear browser data" calls `clearAuthCache()` (`browser-profile.ts:115`), so it must rewarm every routed host before it reloads any guest.
- **Answer `login` narrowly.** Reply only when `authInfo.isProxy`, the host is `127.0.0.1`, and the port is one of ours. Do not require a `webContents`: session traffic, service workers, and the spellchecker dictionary download arrive without one. A wrong credential makes Chromium retry 32 times and end in `ERR_TOO_MANY_RETRIES`. Credentials in the proxy URL (`http://user:pass@…`) are refused with `ERR_NO_SUPPORTED_PROXIES`.
- **`Proxy-Authorization` is on every plain-HTTP request**, and it must not reach the origin. Strip it and the other hop-by-hop headers on each request, not only the first of a connection.
- **`103 Early Hints` breaks hand-rolled parsing.** After a `1xx`, Chromium reuses the connection and sends the next request, credential included, on the same pipe. A proxy that parses headers once and then pipes raw bodies forwards that credential upstream. Use `node:http` for plain requests and `CONNECT`, serve one request per connection, and close after the final response. The cost is one tunnel stream per plain-HTTP request, which is a round trip on a relay; HTTPS goes through `CONNECT` and Chromium reuses its own connection.
- **Always set `proxyBypassRules: "<-loopback>"`.** Without it Chromium sends `localhost`, `127.0.0.1`, `*.localhost`, and `[::1]` straight out, and the tab silently shows the desktop's own loopback. Through a SOCKS-style address, IP literals arrive in the domain field (`::1` without brackets), so the daemon accepts literals there; names such as `*.localhost` are resolved on the host.
- **Await `setProxy` before the webview attaches.** The race was not reproduced in 40 attempts, but a partition without a proxy uses the system configuration and leaves through the local network. `will-attach-webview` refuses a routed partition that is not ready.
- **Never use `socks4://`.** Chromium resolves DNS locally for it. If SOCKS is ever revisited, write `socks5://`.
- **A failed tab is blank.** Electron does not render Chromium's error page; the guest keeps the URL with an empty document. The reason is only in `did-fail-load`, which the app maps to host-aware text in `packages/app/src/desktop/browser/network-routing/load-error.ts`. A `502` body from the proxy does render for `http://`, but `https://` only gets `ERR_TUNNEL_CONNECTION_FAILED`.
- **Without a provider the proxy answers `503`.** A routed partition never falls back to the local network, even while the host is disconnected.

## Known limits

- A genuine `503` or `-100` from a site also triggers one reload of the host's tabs per provider registration.
- Popups inherit the partition of the tab that opened them.
- WebAuthn and passkeys run on the client, not the host. Only the network is routed; the renderer and its platform authenticator stay on the desktop. A site that demands a passkey or any hardware-bound factor registered on the host's machine cannot complete the challenge in a routed tab, and a risk engine may reject the unfamiliar device. The host's own browser still signs in. Register a roaming authenticator (a security key) or a passkey on the desktop to sign in there.
- Mobile, plain-browser web, and port forwarding outside the native browser are out of scope.

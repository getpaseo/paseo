# Security

Paseo follows a client-server architecture, similar to Docker. The daemon runs on your machine and manages your coding agents. Clients (the mobile app, CLI, or web interface) connect to the daemon to monitor and control those agents.

Your code never leaves your machine. Paseo is a local-first tool that connects directly to your development environment.

## Architecture

The Paseo daemon can run anywhere you want to execute agents: your laptop, a Mac Mini, a VPS, or a Docker container. The daemon listens for connections and manages agent lifecycles.

Clients connect to the daemon over WebSocket. There are two ways to establish this connection:

- **Relay connection** — The daemon connects outbound to our relay server, and clients meet it there. No open ports required.
- **Direct connection** — The daemon listens on a network address and clients connect directly.

## Relay threat model

The relay is designed to be untrusted. All traffic between your phone and daemon is end-to-end encrypted. The relay server cannot read your messages, see your code, or modify traffic without detection. Even if the relay is compromised, your data remains protected.

### How it works

1. The daemon generates a persistent Curve25519 keypair on first run and stores it at `$PASEO_HOME/daemon-keypair.json` with mode `0600`
2. The pairing URL (rendered as a QR code or opened directly) carries the daemon's public key in its URL fragment (`https://app.paseo.sh/#offer=...`). Fragments are not sent to the web server, so `app.paseo.sh` never sees the key.
3. When the phone connects via the relay, it generates a fresh ephemeral Curve25519 keypair and sends an `e2ee_hello` message containing its public key. The daemon will not process any application messages until this handshake completes.
4. Both sides perform a Curve25519 ECDH key exchange to derive a shared key. All subsequent messages are encrypted with XSalsa20-Poly1305 (NaCl `box`). The encrypted bundle is `[24-byte nonce][ciphertext]`. Peers optionally negotiate `binaryCiphertext` in `e2ee_hello` / `e2ee_ready`: negotiated application text is carried as a base64 WebSocket text frame, while application binary is carried as a raw WebSocket binary frame. A peer that does not negotiate the capability uses base64 text frames for both kinds.

The WebSocket opcode is preserved end to end after negotiation; the receiver never guesses whether authenticated plaintext is text or binary from its byte contents. The plaintext handshake remains WebSocket text and contains only public keys and capability declarations.

The relay sees only: IP addresses, timing, message sizes, session IDs, and the plaintext `e2ee_hello` / `e2ee_ready` handshake frames (which contain only public keys). It cannot read message contents, forge messages, or derive encryption keys from observing the handshake.

### Why the relay can't attack you

The daemon requires a valid cryptographic handshake before processing any commands. A compromised relay cannot:

- **Impersonate the daemon to your phone** — Without the daemon's secret key, it cannot derive the shared key, so any traffic it injects fails authenticated decryption on the phone
- **Send commands as you** — The daemon only accepts traffic that decrypts and authenticates under a shared key derived with its own secret key. The phone's keypair is ephemeral per connection, so there is no persistent phone-side secret to steal; protection comes from the daemon's secret key never leaving the daemon.
- **Read your traffic** — All messages are encrypted with XSalsa20-Poly1305 (NaCl box) after the handshake
- **Forge messages** — NaCl box provides authenticated encryption; tampered messages are rejected
- **Replay old messages across sessions** — Each session derives fresh encryption keys, so ciphertext from one session cannot be replayed into another session. Within a live session, replay protection is not yet implemented; the protocol uses random nonces and does not track nonce reuse or message counters.

### Trust model

The QR code or pairing link is the trust anchor. It contains the daemon's public key, which is required to establish the encrypted connection. Treat it like a password — don't share it publicly.

## Local daemon trust boundary

By default, the daemon binds to `127.0.0.1`. With no password configured, the local control plane is trusted by network reachability — anything that can reach the daemon socket can control the daemon. This is the same security model Docker documents for its daemon: the security boundary is access to the socket or listening address.

The daemon also supports an optional shared-secret password (set via `auth.password` in `config.json` or the `PASEO_PASSWORD` env var; stored bcrypt-hashed). When configured, every HTTP request must carry `Authorization: Bearer <password>` and every WebSocket upgrade must include a `Sec-WebSocket-Protocol: paseo.bearer.<password>` subprotocol. Browser WebSocket cannot set custom headers, which is why the token rides in the subprotocol. Health (`GET /api/health`) and CORS preflight (`OPTIONS`) are exempt. The password is intended for direct-TCP exposure (e.g. `tcp://host:port?ssl=true&password=...`); it is **not** a substitute for the relay's E2E encryption when traversing untrusted networks.

Connected clients are trusted operators of the daemon user. File previews follow that authority: a preview request may read any regular file the daemon process can read, while keeping path normalization and symlink checks in the daemon file service. Workspace-relative paths remain a UI convenience, not a security boundary.

If you expose the daemon beyond loopback, such as by binding to `0.0.0.0`, forwarding it through a tunnel or reverse proxy, or publishing it from a Docker container, you are responsible for restricting and securing that access. Setting a password is strongly recommended in that case.

In Docker, the official image runs the daemon and agents as the non-root
`paseo` user by default. Mounted workspaces and credentials are still fully
available to anything the agents run inside the container.

For remote access, use the relay connection. It is the supported path for reaching the daemon off-machine, and it adds end-to-end encryption plus a pairing handshake before commands are accepted.

Host header validation and CORS origin checks are defense-in-depth controls for localhost exposure. They help block DNS rebinding and browser-based attacks, but they do not replace network isolation.

## DNS rebinding protection

CORS is not a complete security boundary. It controls which browser origins can make requests, but does not prevent a malicious website from resolving its domain to your local machine (DNS rebinding).

Paseo validates the `Host` header on every HTTP request and every WebSocket upgrade against an allowlist (Vite-style semantics). By default, only `localhost`, `*.localhost`, and any literal IP address (IPv4 or IPv6) are accepted. Additional hostnames can be configured via `hostnames` in `config.json` or the `PASEO_HOSTNAMES` env var (comma-separated; entries beginning with `.` match a domain and its subdomains; the value `true` disables the allowlist entirely). Requests with unrecognized hosts are rejected with `403 Host not allowed`.

## Agent authentication

Paseo wraps agent CLIs (Claude Code, Codex, OpenCode) but does not manage their authentication. Each agent provider handles its own credentials. Paseo never stores or transmits provider API keys. Agents run in your user context with your existing credentials.

## Plugins

Plugins are third-party HTML rendered by the client. They run in a sandboxed frame with no storage and no origin, and they reach the app only through a fixed `postMessage` bridge. A plugin sees the content of files you preview with it and can ask the app to open a path inside the workspace; it cannot call the daemon or reach anything else.

Keeping that content on the machine depends on six separate controls: a CSP on the plugin that denies the network requests CSP can express; deletion of `RTCPeerConnection` from the plugin's realm, because no CSP directive covers WebRTC and a plugin otherwise chooses both the ICE server and the payload; removal of nested frames as they are inserted, because a child realm is created with its own untouched `RTCPeerConnection` and cannot be injected into; `frame-src 'none'` on the app's own document so the plugin frame cannot navigate itself out (the guest CSP cannot stop that — a frame's navigation is checked against its parent's policy); an iframe with no `allow-forms`/`allow-popups`/`allow-top-navigation`/`allow-same-origin`; and a deny-by-default navigation check on native. Native loads that same sandboxed iframe inside a host document rather than running the plugin as the WebView's top document: an unsandboxed top document hands its own origin to any frame the plugin creates, which makes the child readable in the same task it is inserted, before any runtime removal can run.

Any one failing is an exfiltration path. All six did fail during this feature's review, across five rounds, and every one passed the full test suite — so changes to the sandbox need a test that proves the denial in a real browser, driven from where the attacker's code runs rather than from the host. The last round is the one to keep in mind: the frame remover was defeated by poisoning the DOM methods it called and by `document.write()` detaching it from the tree, so a runtime mitigation has to assume the plugin will attack the mitigation itself. [docs/plugins.md](docs/plugins.md) documents the sandbox and the bridge.

The daemon serves a plugin's HTML only while that plugin is enabled and only for entries its manifest declares, and it resolves symlinks before re-checking that the file is inside the plugin directory.

The registry is a trust boundary. The daemon verifies each downloaded file against the SHA-256 in the index, which protects the bytes in transit but says nothing about the publisher's intent — installing a plugin means trusting whoever published it. Downloads are capped while streaming rather than after buffering, so a registry host that declares a small file and serves a huge one cannot exhaust daemon memory. Point `daemon.plugins.registryUrl` at your own index if you want to control what is installable.

## Forge host trust

Paseo only talks to a forge host that is either a known cloud host or one the forge CLI is already authenticated to. It never probes or routes credentials to an unauthenticated, remote-derived host.

## Reporting vulnerabilities

If you discover a security vulnerability, please report it privately by emailing hello@moboudra.com. Do not open a public issue.

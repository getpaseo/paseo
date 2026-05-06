---
title: Security
description: "Security model for Paseo: architecture overview, connection methods, relay encryption, and best practices."
nav: Security
order: 9
---

# Security

Paseo follows a client-server architecture, similar to Docker. The daemon runs on your machine and manages your coding agents. Clients (the mobile app, CLI, or web interface) connect to the daemon to monitor and control those agents.

Your code never leaves your machine. Paseo is a local-first tool that connects directly to your development environment.

## Architecture

The Paseo daemon can run anywhere you want to execute agents: your laptop, a Mac Mini, a VPS, or a Docker container. The daemon listens for connections and manages agent lifecycles.

Clients connect to the daemon over WebSocket. There are two ways to establish this connection:

- **Relay connection (recommended)** — The daemon connects outbound to our relay server, and clients meet it there. No open ports required.
- **Direct connection** — The daemon listens on a network address and clients connect directly.

## Relay connections (recommended)

The relay is the simplest way to connect from your phone. It requires no VPN setup, no port forwarding, and no firewall configuration. The daemon can stay bound to localhost or a socket file — it connects _outbound_ to the relay, and your phone meets it there.

> **The relay is designed to be untrusted.** All traffic between your phone and daemon is end-to-end encrypted. The relay server cannot read your messages, see your code, or modify traffic without detection. Even if the relay is compromised, your data remains protected.

### How it works

1. The daemon generates a persistent ECDH keypair and stores it in `$PASEO_HOME/daemon-keypair.json`
2. When you scan the QR code or click the pairing link, your phone receives the daemon's public key
3. Your phone sends a handshake message with its own public key. The daemon will not accept any commands until this handshake completes.
4. Both sides perform an ECDH key exchange to derive a shared secret. All subsequent messages are encrypted with AES-256-GCM.

The relay sees only: IP addresses, timing, message sizes, and session IDs. It cannot read message contents, forge messages, or derive encryption keys from observing the handshake.

### Why the relay can't attack you

The daemon requires a valid cryptographic handshake before processing any commands. A compromised relay cannot:

- **Send commands** — Without your phone's private key, it cannot complete the handshake
- **Read your traffic** — All messages are encrypted with AES-256-GCM after the handshake
- **Forge messages** — GCM provides authenticated encryption; tampered messages are rejected
- **Replay old messages** — Each session derives fresh encryption keys

### Trust model

The QR code or pairing link is the trust anchor. It contains the daemon's public key, which is required to establish the encrypted connection. Treat it like a password — don't share it publicly.

If you believe a pairing offer has been compromised, restart the daemon to generate a new session ID and rotate the relay pairing.

## Direct connections

By default, the daemon listens on `127.0.0.1:6767` (localhost only). This is safe for local CLI usage but not reachable from your phone or other devices.

### Socket file (CLI only)

For maximum isolation, you can configure the daemon to listen on a Unix socket file instead of a TCP port. This prevents any network access entirely — only processes on the same machine can connect. The CLI supports this mode, but the mobile app and web interface require a network connection.

### VPN access

If you prefer direct connections over the relay, you can use a VPN like [Tailscale](https://tailscale.com). Tailscale creates a private network between your devices, so you can access your daemon without exposing it to the public internet.

To set this up:

1. Install Tailscale on your machine and phone and join them to the same [tailnet](https://tailscale.com/kb/1136/tailnet)
2. Configure the daemon to listen on your Tailscale IP (e.g., `100.x.y.z:6767`)
3. Add your Tailscale hostname to `hostnames` and `cors.allowedOrigins`
4. Add the daemon as a direct connection in the Paseo app using the Tailscale address

### Binding to 0.0.0.0

> **Warning:** Binding to `0.0.0.0` makes the daemon reachable on all network interfaces, including public Wi-Fi and local networks. This can expose your daemon to unauthorized access. If you must bind to all interfaces, ensure you have proper firewall rules and review your `hostnames` configuration.

## DNS rebinding protection

**CORS is not a complete security boundary.** It controls which browser origins can make requests, but does not prevent a malicious website from resolving its domain to your local machine (DNS rebinding).

Paseo uses a host allowlist to validate the `Host` header on incoming requests. Requests with unrecognized hosts are rejected.

Configure via `daemon.hostnames` in `config.json`:

- Default (`[]`): allow `localhost`, `*.localhost`, and all IP addresses
- `['.example.com']`: allow `example.com` and any subdomain, plus defaults
- `true`: allow any host (not recommended)

## Password authentication

By default, anyone who can reach the daemon's listening address can connect. On localhost this is fine — only local processes have access. But if you bind to a network interface (e.g. your LAN IP or `0.0.0.0`), or if you don't fully trust your local network, you can require a password.

When a password is configured, all HTTP requests must include an `Authorization: Bearer <password>` header and all WebSocket connections must authenticate via subprotocol. Unauthenticated requests receive a `401 Unauthorized` response. Only the `/api/health` liveness endpoint is exempt, so that process supervisors and load balancers can probe without credentials.

The password is stored as a bcrypt hash in `config.json` — the daemon never stores it in plaintext. See [Configuration](/docs/configuration#password-authentication) for setup instructions.

### What password auth does and does not do

- **Does:** Prevents unauthorized clients from controlling your agents, even if they can reach the daemon over the network.
- **Does not:** Encrypt traffic. Password auth protects access, not confidentiality. If you need encrypted connections over an untrusted network, use the relay (which provides end-to-end encryption) or a VPN like Tailscale.

### When to use it

- You want to bind the daemon to a LAN or Tailscale address and restrict who can connect.
- You don't fully trust your local network (shared office, public Wi-Fi with a VPN, etc.).
- You're exposing the daemon via a reverse proxy and want an additional authentication layer.

We still recommend the relay for mobile access — it combines authentication with end-to-end encryption out of the box. Password auth is primarily useful for direct LAN or VPN connections where you want access control without the relay.

## Agent authentication

Paseo wraps agent CLIs (Claude Code, Codex, OpenCode) but does not manage their authentication. Each agent provider handles its own credentials:

- **Claude Code** — authenticates via Anthropic's OAuth flow, stored in `~/.claude/`
- **Codex** — uses your OpenAI API key or OAuth session
- **OpenCode** — configured via provider-specific API keys

Paseo never stores or transmits provider API keys. Agents run in your user context with your existing credentials.

## Recommendations

- **Use the relay** for mobile access — it's the simplest option and all traffic is end-to-end encrypted
- **Treat the QR code like a password** — anyone with the pairing offer can connect to your daemon
- **Set a password** if you bind to a network address — it prevents unauthorized clients from controlling your agents
- **Never bind to 0.0.0.0 without a password** — without one, any device on your network can connect
- **Keep your daemon updated** — security improvements are released regularly

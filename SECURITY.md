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

1. The daemon generates a persistent ECDH keypair and stores it locally
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

## DNS rebinding protection

CORS is not a complete security boundary. It controls which browser origins can make requests, but does not prevent a malicious website from resolving its domain to your local machine (DNS rebinding).

Paseo uses a host allowlist to validate the `Host` header on incoming requests. Requests with unrecognized hosts are rejected.

## Agent authentication

Paseo wraps agent CLIs (Claude Code, Codex, OpenCode) but does not manage their authentication. Each agent provider handles its own credentials. Paseo never stores or transmits provider API keys. Agents run in your user context with your existing credentials.

## Reporting vulnerabilities

If you discover a security vulnerability, please report it privately by emailing security@paseo.sh. Do not open a public issue.

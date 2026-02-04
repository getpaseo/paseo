# Relay + E2EE architecture (draft)

This doc captures a **draft** design for adding support for connecting a Paseo client to a Paseo daemon through the deployed relay at `relay.paseo.sh`, while keeping existing direct LAN/WebSocket connectivity working.

The relay is treated as **fully untrusted**: it may observe traffic metadata (timing, sizes) but must not be able to read or modify plaintext without detection.

## Current state (what exists today)

- **Daemon (server)** hosts an HTTP server + WebSocket server at `/ws`.
  - Entry: `packages/server/src/server/bootstrap.ts`
  - WS transport: `packages/server/src/server/websocket-server.ts`
- **Client (app)** connects directly to a daemon WebSocket URL (stored as a “daemon profile”).
  - Registry: `packages/app/src/contexts/daemon-registry-context.tsx`
  - Connection: `packages/app/src/hooks/use-daemon-client.ts` → `DaemonClient` in `packages/server/src/client/daemon-client.ts`
- **Relay** already exists as a Cloudflare Durable Object that bridges two WebSockets:
  - Endpoint: `wss://relay.paseo.sh/ws?session=<id>&role=server|client`
  - Implementation: `packages/relay/src/cloudflare-adapter.ts`
- **E2EE primitives** already exist in `@paseo/relay`:
  - Crypto: `packages/relay/src/crypto.ts` (ECDH P-256 → HKDF → AES-256-GCM)
  - Handshake wrapper: `packages/relay/src/encrypted-channel.ts`
  - Local E2E tests: `packages/relay/src/e2e.test.ts`

## Design goals

1. **One source of truth** for connectivity: the daemon decides what it is offering and publishes a single “connection offer” to the user (QR + link). That offer contains a list of WebSocket endpoints (LAN + relay, etc).
2. **Transport-independence**: client/daemon message protocol is identical whether carried over direct WebSocket or relay WebSocket.
3. **E2EE-first design**: encryption is not bolted on; the transport layer supports E2EE so the relay remains untrusted.
4. **Incremental rollout**: allow shipping relay support without immediately requiring native QR-scanning, while keeping a path to full UX.

## Proposed model

### 1) ConnectionOffer (pairing payload)

The daemon emits a single JSON “connection offer”, encoded into:

- A terminal QR code (for mobile scanning)
- A clickable URL that opens `https://app.paseo.sh` and passes the payload

Draft shape:

```ts
type ConnectionOfferV1 = {
  v: 1;
  // Shared across all endpoints; clients connect to *the same session* regardless
  // of which endpoint ends up working.
  sessionId: string;
  // Endpoints, in priority order, as plain "{host}:{port}" strings.
  //
  // Examples:
  // - "192.168.1.12:9172" (LAN)
  // - "100.64.0.10:9172" (tailscale)
  // - "relay.paseo.sh:443" (relay)
  endpoints: string[];
  // E2EE pairing material. Mandatory because the relay is untrusted.
  daemonPublicKeyB64: string;
};
```

Notes:
- The offer does not try to encode “relay vs LAN” as separate types. They’re just endpoints.
- Clients derive the actual WebSocket URL using the stable WS path (`/ws`) and the same query params for all endpoints:
  - `?session=<sessionId>&role=client`
  - Direct LAN daemons can ignore these params; the relay uses them to rendezvous.
- Manual entry of a WebSocket URL remains supported; the offer is for pairing + convenience.

### 2) Transport layering (where encryption lives)

We want the **Session protocol** (the JSON messages validated by zod) to remain unchanged.

Encryption should wrap the raw WebSocket transport:

```
Session protocol (JSON)  <-- unchanged
  ↕
E2EE framing (EncryptedChannel)  <-- new shared layer
  ↕
Underlying WebSocket (direct LAN OR relay)
```

This keeps “LAN vs relay” strictly a *transport choice*, not a protocol fork.

### 3) Relay mode on the daemon

In relay mode, the daemon should be able to run with **no externally reachable TCP listener** (or only a local unix socket / localhost listener), while still serving remote clients through the relay.

Draft behavior:

- Daemon generates a new relay `sessionId` (ephemeral).
- Daemon connects out to `wss://relay.paseo.sh/ws?session=<id>&role=server`.
- Daemon prints a `ConnectionOfferV1` that contains `sessionId` + a relay endpoint like `relay.paseo.sh:443`.
- When the client connects + performs handshake, the daemon establishes an `EncryptedChannel` and then routes decrypted JSON messages into the existing session handler.

### 4) LAN endpoints (same flow)

LAN is not special: the offer can include LAN endpoints (`"host:port"`) and the client still does:

scan once → connect → E2EE → session protocol.

## Open questions (need product decisions)

1. **Session lifetime**: relay `sessionId` scope (e.g. rotate on daemon restart vs keep stable until revoked).
2. **Multi-client**: do we want multiple relay clients attached concurrently, and if yes, how do we mint/encode per-client relay sessions?
3. **Reconnection semantics**: client sleep/reconnect behavior (reuse the same relay session vs require re-scan).
4. **Device identity**: session-scoped E2EE keys vs persistent “trusted device” keys.
5. **Native crypto availability**: web + Expo native need a workable WebCrypto story (polyfill if needed).
6. **Manual entry**: always allow manual WebSocket URLs; decide what UX to show when the user bypasses the offer (since the offer is the only place we can safely bundle the daemon public key).

## Security properties (target)

- Relay sees: IPs, timing, byte sizes, session IDs, role.
- Relay cannot: read plaintext, forge messages undetected (AES-GCM provides integrity), derive session keys from observed handshake.
- Threat not covered (for v1):
  - Metadata privacy (traffic analysis).
  - Active MITM between client and daemon if the client is tricked into using an attacker’s daemon public key (QR/link authenticity is the root).

## Testing strategy

### A) Local relay E2E (already exists)

- `packages/relay/src/e2e.test.ts` spins a local node relay and verifies encrypted exchange.

### B) Live relay verification (should exist)

Have a test or script that:
- connects to `wss://relay.paseo.sh`
- runs the handshake
- exchanges encrypted frames

This proves that the deployed relay can transport encrypted traffic correctly end-to-end.

### C) Daemon ↔ client protocol through relay (future)

Once daemon relay mode exists:
- start daemon in relay mode
- connect a client (Node-based harness first, then app)
- assert that a minimal Session RPC works (e.g. `load_conversation_request` → `conversation_loaded`)

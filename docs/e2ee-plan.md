# End‑to‑End Encryption (E2EE) Plan — Draft

## Goal
Provide end‑to‑end encryption for **relay connections only**. Direct connections (including CLI) remain plaintext. The relay remains a dumb byte forwarder. Pairing flows (QR/link) stay the same, but only relay transports perform the E2EE handshake.

## Current State (What Exists)
- **E2EE primitives** in `@paseo/relay`:
  - `packages/relay/src/crypto.ts` — ECDH P‑256 + HKDF + AES‑GCM.
  - `packages/relay/src/encrypted-channel.ts` — handshake (`hello`) + encrypted channel wrapper.
  - Tests simulate full key exchange and encrypted relay traffic.
- **Pairing offer** already includes public key:
  - `packages/server/src/server/connection-offer.ts` creates `daemonPublicKeyB64` and embeds it in the offer.
  - `packages/server/src/server/bootstrap.ts` emits pairing offer + QR via `printPairingQrIfEnabled`.
- **App pairing UX** exists:
  - QR scan & link import in `packages/app/src/app/pair-scan.tsx` and `OfferLinkListener`.
  - Offer parsing stores `daemonPublicKeyB64` + relay `sessionId` in the daemon registry.
- **Transport is still plaintext**:
  - Server WebSocket bridge expects raw JSON (`packages/server/src/server/websocket-session-bridge.ts`).
  - Relay transport just forwards WebSocket frames (`packages/server/src/server/relay-transport.ts`).
  - `DaemonClientV2` uses raw WebSocket transport (`packages/server/src/client/daemon-client-v2.ts`).

## Gaps / Missing Pieces
1. **Daemon keypair is not stored** — `createConnectionOfferV1` generates a new keypair and discards the private key, so the daemon cannot complete the handshake later.
2. **No encrypted transport integration** in the server or client.
3. **React Native WebCrypto support** is missing; `expo-crypto` polyfill only provides random values/UUID.
4. **Manual add host** (host:port only) does not need a public key for direct/plaintext, but still needs it for relay/E2EE.
5. **Tests still assume plaintext** (relay ping/pong, app e2e, etc.).
6. **Non‑WS channels** (HTTP download endpoints) are not E2EE and need explicit scope decision.

## Proposed Design
### 1) Daemon E2EE Context (server)
- Generate **one daemon keypair** and **persist it in `$PASEO_HOME`** to survive restarts.
- `daemonPublicKeyB64` in the offer should come from this stored keypair.
- Keep existing `connectionSessionId` for relay sessions.

### 2) Encrypted Transport Layer (relay only)
- **Server side**: wrap relay‑attached WebSockets in an `EncryptedChannel` **before** message parsing.
  - On connect: `createDaemonChannel(wsTransport, daemonKeyPair)`.
  - When the channel opens, forward decrypted messages to the session and encrypt outbound messages.
  - If handshake fails, close the socket with a clear reason.
- **Client side**: wrap relay WebSocket transport in `createClientChannel`.
  - Use `daemonPublicKeyB64` from the pairing offer as the trust anchor.
  - After handshake, all messages are encrypted JSON strings.

Direct connections remain plaintext (no handshake). CLI stays plaintext as well.

### 3) Transport Adapters
Implement a minimal adapter that maps `ws`/browser sockets to the `EncryptedChannel` `Transport` interface.
- `send(data)` → raw `ws.send`.
- `onmessage`/`onclose`/`onerror` wired to underlying events.
- Ensure binary vs text handling is consistent (the encrypted channel currently base64‑encodes ciphertext as text).

### 4) Client Configuration & API
- Extend `DaemonClientV2Config` (or app wrapper) to accept an **E2EE config** for relay use only:
  - `daemonPublicKeyB64` (required for relay E2EE).
  - `e2eeEnabled` (true for relay transports, false for direct/CLI).
- `useDaemonClient` should pass the host’s `daemonPublicKeyB64` when connecting via relay.
- Update test utilities (`test-daemon-connection.ts`) to supply keys when needed.

### 5) Crypto / Base64 / WebCrypto Compatibility
- Keep crypto **WebCrypto-compatible** so Expo can polyfill SubtleCrypto.
- Ensure **WebCrypto Subtle** is available in all runtimes:
  - Web: native OK.
  - Node: native OK.
  - React Native: **add a SubtleCrypto polyfill** (library decision needed).
- Replace `btoa/atob` usage in `@paseo/relay` (or wrap with a helper) to support RN environments.

### 6) Pairing & Trust Model
- The **QR/link offer is the trust anchor** (daemon public key + session ID).
- Daemon keys persist across restarts. If keys change (deleted/reset), treat it as a **new host** (or prompt to re‑trust).
- Manual host entry is plaintext (direct). Relay connections still require pairing to obtain `daemonPublicKeyB64`.

## Implementation Plan (Draft)
### Phase 0 — Requirements & Decisions
- E2EE is **relay-only**. Direct connections (including CLI) stay plaintext.
- Daemon keypair **persists across restarts**.
- Manual host entry can remain plaintext for direct connections; relay requires pairing to obtain `daemonPublicKeyB64`.
- HTTP downloads remain **out of scope** for E2EE (document as plaintext).

### Phase 1 — Server: Keypair & Offer
- Introduce a daemon E2EE context in `packages/server/src/server/bootstrap.ts` or a new module.
- Replace `generateDaemonPublicKeyB64()` in `connection-offer.ts` with “get from context”.
- Ensure the daemon keypair is retained for handshake and used by `createDaemonChannel`.

### Phase 2 — Server: Encrypted WebSocket Bridge (relay only)
- Add an encrypted wrapper for relay sockets only:
  - Convert `ws` to a `Transport` adapter.
  - Perform handshake (`createDaemonChannel`).
  - After open, forward decrypted messages into session handling.
- Keep direct sockets on the existing plaintext path.

### Phase 3 — Client: Encrypted Transport (relay only)
- Build an encrypted transport factory for relay connections in `DaemonClientV2`:
  - Wrap the raw WS transport in `createClientChannel`.
  - Make connection promise resolve after handshake completes.
- Update `useDaemonClient` to pass `daemonPublicKeyB64` for relay connections.
- Update `test-daemon-connection.ts` and other utilities that instantiate `DaemonClientV2` when relay is used.

### Phase 4 — Crypto Runtime Support
- Add WebCrypto Subtle polyfill for React Native.
- Add base64 helpers compatible with both web and RN (buffer fallback).

### Phase 5 — E2E + Regression Tests
- Update server e2e: `daemon-e2e/relay-transport.e2e.test.ts` to use handshake + encrypted ping/pong.
- Update app e2e relay fallback tests if necessary.
- Add unit tests for `EncryptedTransport` (client) and handshake failures.

### Phase 6 — UX / Edge Handling
- Show clear UI errors when handshake fails or public key is missing.
- Add re‑pair flow when daemon key changes.

## Verification / Acceptance Criteria
- App connects via relay using the **encrypted handshake**.
- Relay sees only opaque bytes after handshake.
- No plaintext JSON messages are exchanged after handshake on relay paths.
- Direct connections (including CLI) remain plaintext and continue to work.
- Pairing QR/link remains the only trust anchor.
- Reconnects re‑establish E2EE automatically.

## Open Questions / Requirements
1. **Any UX requirements** for key changes (warnings, re‑pair prompt, automatic update)?
2. **Should we version the handshake** message format now (e.g., add `v: 1`)?

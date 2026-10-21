# Relay endpoint security

The relay carries daemon sessions between a client and a daemon that cannot reach each other directly. The relay is untrusted, so the two endpoints secure the session themselves. This doc owns the protected construction, its mapping onto Paseo's handshake and record flow, the negotiation rules, and the enforcement flag. The threat model lives in [SECURITY.md](../SECURITY.md); the code is `packages/relay/src/secure-channel.ts`.

Fixes [#359](https://github.com/getpaseo/paseo/issues/359): the legacy construction has no replay protection. A recorded legacy hello plus records replays onto a fresh daemon channel, and duplicated records are delivered twice.

## Two modes

| Mode        | Construction                                     | Replay protection                |
| ----------- | ------------------------------------------------ | -------------------------------- |
| `legacy`    | X25519 + NaCl `box`, random nonces               | none                             |
| `protected` | `Noise_NK_25519_ChaChaPoly_SHA256` (revision 34) | counters, fresh daemon ephemeral |

Two updated peers always negotiate `protected`. An old peer on either side falls to `legacy` while the daemon permits it. Everything in `packages/relay/src/encrypted-channel.ts` is the legacy construction and is unchanged.

The shared entry points are `openClientSecureChannel` and `openDaemonSecureChannel`. Callers get a `SecureChannel` and ask it `securityMode()`; nothing outside the module branches on the construction.

## Noise mapping

- **Pattern:** NK. The daemon's static key is the existing `$PASEO_HOME/daemon-keypair.json` X25519 key that pairing already distributes. There is no second daemon identity.
- **Prologue:** the ASCII bytes `paseo-relay-e2ee/1`.
- **Primitives:** `@noble/curves` x25519, `@noble/ciphers` ChaCha20-Poly1305, `@noble/hashes` SHA-256 and HMAC. The state machine in `packages/relay/src/noise/` is our own implementation of the spec and is checked against vendored third-party vectors in `noise/fixtures/`.
- **Message 1** (`-> e, es`) travels inside the legacy hello: `{ type: "e2ee_hello", key, capabilities, protected: { v: 1, message: <base64> } }`. `key` is a separate legacy ephemeral so an old daemon still completes a legacy handshake. The Noise payload is the offered parameters.
- **Message 2** (`<- e, ee`) travels inside the ready: `{ type: "e2ee_ready", protected: { v: 1, message: <base64> } }`. Its payload is the selected parameters. The outer `capabilities` field is ignored in protected mode because it is not authenticated.
- **Parameters payload:** two bytes, `[0x01 version][flags]`. Flag bit 0 is `binaryCiphertext`. Unknown versions, reserved flag bits, and a selection the client did not offer fail the handshake.
- **Split:** the initiator sends with the first cipher state and receives with the second. The daemon is the mirror. Nonces are 64-bit little-endian in a 12-byte nonce, reserved synchronously before any await, never wrapped. A receiver advances its counter only after the tag verifies.

Nothing else is bound into the handshake. The outer JSON, the relay URL, and session credentials are not authenticated by Noise. Credentials travel in the application `hello` after message 2 verified the daemon.

## Records

Each application frame becomes one record of one or more Noise transport messages:

```
chunk plaintext = kind(1) || flags(1) || totalLength(u32 BE) || data
wire record     = (u16 BE ciphertextLength || ciphertext)+
```

`kind` is `0x00` text or `0x01` binary. `flags` bit 0 marks the first chunk and bit 1 the last. `data` is at most 65513 bytes per chunk, so a chunk never exceeds the Noise message limit. The chunk count is `max(1, ceil(totalLength / 65513))`.

The receiver rejects a record whose metadata disagrees between chunks, whose non-final chunks are not full, whose byte total differs from `totalLength`, or that has zero chunks, trailing bytes, reserved flags, or an invalid kind. Partial plaintext never reaches the application. Transport AD is empty, as the Noise spec writes it; framing authenticity comes from the metadata being inside the ciphertext. `packages/relay/src/protected-records.ts` owns this.

Frame kind is preserved on the wire the same way as legacy: text records are base64 WebSocket text, binary records are WebSocket binary when `binaryCiphertext` was negotiated.

## Retries and failures

- The client resends its hello every second until a ready arrives. The daemon caches the exact hello text and ready text for the channel. An identical hello gets the identical ready and counters keep running. A different hello closes the channel (`1008`, transcript mismatch). A ready after the channel is open is ignored.
- A fresh daemon channel always generates a fresh `e`, so a recorded hello and its records fail authentication when replayed later, including after a daemon restart.
- A present but invalid `protected` field fails the handshake. There is no fallback to legacy once protected was attempted.
- Any record failure (bad tag, duplicate, reordered, reflected, malformed) closes the channel and nothing from that record is delivered. The daemon closes with `1011`; the client closes with `4003`, because a browser `WebSocket.close` accepts only `1000` and `3000`-`4999`.
- A record header is checked against the bytes actually received before any buffer is allocated for it, so a header claiming gigabytes costs nothing.
- Keys are cleared on close as a best effort.

## Negotiation and admission

The daemon advertises `server_info.features.relayProtectedSecurity: true` on every session, whatever mode that session negotiated. A relay client that ended up in `legacy` with such a daemon closes with `4002` before the client marks itself connected, restores subscriptions, or flushes queued commands. The check lives in the relay E2EE transport, so it also covers the Node connector; direct connections never see it.

The app pins `minimumSecurityMode: "protected"` on every relay connection to a daemon public key after the first protected handshake with that key, or when the pairing offer carries `minimumSecurityMode`. A pinned client passes `minimumMode: "protected"` to the handshake and refuses a legacy ready before sending credentials. The pin belongs to the daemon identity, not to a relay address: re-importing the same key through any relay keeps it, a different key is a different connection, and connection failures never clear it.

The handshake result is read in one place, `HostRuntimeController` when the host's active client reports connected. Every client reaches that point, whether the controller created it or adopted it from a pairing or startup probe, so no client constructor carries a persistence callback. A probe that negotiated protected but was never adopted pins nothing; the pin lands when the host first goes online.

Within one client process the floor also rises on its own. `DaemonClient` and the Node host connector remember a protected result and require it on every later attempt, so a reconnect after a relay drop cannot be answered in legacy mode even before the pin is persisted.

The daemon refuses a legacy client with close `1008` and reason `protected endpoint security required`, and logs `relay_e2ee_handshake_rejected`. That close code stops at the relay: both relays replace a daemon-side close with their own (the wrangler relay sends `1012 Server disconnected`), so an old client sees an ordinary disconnect and keeps retrying. The only client-detectable failure is the client's own `4002`, which stops reconnecting and tells the user to update.

The client learns its own `4002` and `4003` from the relay E2EE transport, which reports the close the moment the channel decides it. A socket close event arrives later and the channel's error callback earlier; neither is what `DaemonClient` acts on, because acting on the error would start a reconnect before the code is known.

## Enforcement flag

`daemon.relay.requireProtectedSecurity` in `config.json` (also `relay.requireProtectedSecurity` through the config RPC) makes the daemon refuse legacy relay clients. Default `false`. It is a local daemon setting with no relay-server counterpart.

- It is read when each hello arrives, so toggling it affects the next admission without a restart. Sessions already admitted in legacy mode stay up until they disconnect; turning the flag on does not close them. To finish enforcement, restart the daemon or disconnect its relay sessions after enabling the flag: every reconnect is then a new admission and legacy clients are refused.
- While it is on, pairing offers carry `minimumSecurityMode: "protected"` and `relay://` URIs carry `security=protected`, so new clients pin before their first handshake.
- Direct and local connections are outside the flag.

Flipping the default is a separate decision, tentatively reviewed about 30 days after the compatibility release. Nothing in the code expires on a date.

## Known limitation

While a daemon accepts legacy clients, a transcript recorded from any legacy session (hello, credentials, commands) can still be replayed to it. Pinning on the client does not change that, because the attacker replays the old client's transcript, not the pinned client's. The only remedy is enabling the flag on that daemon.

## Testing

- `packages/relay/src/noise/noise.test.ts`: vendored vectors, replay and out-of-order rejection at the cipher-state level.
- `packages/relay/src/protected-records.test.ts`: framing round trips and every malformed-record rule.
- `packages/relay/src/secure-channel.test.ts`: both modes, mixed versions, policy rejection, retries, recorded-transcript replay, downgrade attempts.
- `packages/server/src/server/websocket/secure-relay-ingress.test.ts`: daemon admission and the flag.
- `packages/server/src/server/daemon-e2e/relay-transport.e2e.test.ts`: real daemon through the wrangler relay. Set `PASEO_RELAY_E2E_PORT` to run the same cases against an already-running relay such as the Elixir relay in Docker.

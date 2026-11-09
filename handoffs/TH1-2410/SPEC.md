# Spec: per-device credentials and pairing tokens (TH1-2410)

Status: draft for Teo's review. Branch `th1-2410-device-credentials` on upstream `main` (supersedes the stale-base draft hteo1337/paseo#9).

## Problem

Since getpaseo/paseo#7668 a password-protected daemon rejects relay hellos without the password. Saved relay hosts never stored one, so each shows "Password required". The pairing QR carries no credential, the daemon keeps only a bcrypt hash, the desktop `localCredential` is direct-only and ephemeral, and nothing issues credentials. Goal: after one trusted admission (or one scan of a QR from a trusted screen) the app reconnects to every host with no typed password.

## Model (from docs/permissions.md)

- Principal: unchanged, `owner`. A device credential proves that a device acts for the owner principal; it is not a new principal. Sessions keep the key `(principalId, clientId)`, so a phone that switches from password to device credential resumes the same session and keeps connected-host ownership.
- Device credential: `{ id, secret }`. `id` = `dc_` + 16 random bytes base64url (public, used for lookup and revocation). `secret` = 32 random bytes base64url (shown once).
- Pairing token: the pairing invitation. Single-use, expires after 10 minutes, memory only, admits one hello as full owner.

## Daemon

### Store

`$PASEO_HOME/device-credentials.json`, mode 0600, atomic write (temp file + rename), zod-validated on load. A malformed file fails closed: no device credential admits, the daemon logs an error and still starts (password and local credential keep working).

Record: `{ id, label, createdAt, secretSha256 }`.

- `secretSha256`: SHA-256 of the 256-bit random secret. bcrypt adds nothing for a uniformly random 256-bit secret and would make every reconnect cost ~100 ms.
- Every credential grants full owner authority (see "Owner-only" below), so no permissions are stored.
- The store is loaded once at startup and kept in memory; admission does no I/O, so a store error can never surface as a transient `incorrect_password`. Writes go through a serialized queue (`writePrivateFileAtomic`, mode 0600). An invalid file is quarantined like `hub-relationship.json`.
- Max 64 records; issue fails with `limit_reached` beyond that.
- Changing the daemon password does not revoke devices. A password-bound credential was considered and dropped: `PASEO_PASSWORD` is re-hashed with a fresh bcrypt salt on every boot, so binding to the hash would wipe every device on restart. Use revoke (or revoke all) instead.

### Admission (`session-admission-auth.ts`)

New hello auth kind `{ kind: "deviceCredential", id, secret }` (id ≤ 64 chars, secret ≤ 128 chars).

- No password configured: unchanged (owner admission, credentials ignored).
- Look up by `id`; compare SHA-256(secret) with `timingSafeEqual`. Unknown id and wrong secret both reject as `incorrect_password` (no new rejection reason, so old wire enums stay valid and no oracle distinguishes unknown from wrong). `hello.rejected.accepts` stays `["password"]`.
- Admits `{ principalId: "owner", permissions: OWNER_PERMISSIONS, credentialId: id }`.

New hello auth kind `{ kind: "pairingToken", token }` (token ≤ 128 chars).

- Valid only if present in the in-memory table (keyed by SHA-256 of the token), unexpired and unused. Looked up and deleted synchronously before any `await` in `resolveSessionAdmission`, so two concurrent hellos cannot both use it. Admits `{ principalId: "owner", permissions: OWNER_PERMISSIONS }`. At most 8 live tokens; minting a ninth evicts the oldest.
- On a daemon without a password it is ignored like any other credential.

Transport: both kinds are accepted on direct and relay. The relay path is E2EE (Noise), so the secret never reaches the relay in clear.

### Owner-only

Issuing a credential or a pairing token requires a session whose principal is `owner` and whose current permissions include every `OWNER_PERMISSIONS` entry. Everything issued therefore carries full owner authority and nothing narrower. This closes a hijack path: sessions are keyed `(principalId, clientId)` and `clientId` is client-chosen, so a narrower owner-principal credential could resume another client's session and narrow its live sockets through `resumeSession`. Hub and other principals get `unsupported_principal`, even with `access.manage`. Routed sessions on a destination are admitted as `owner` through the origin's link, so they can issue when their permissions are not narrowed by a `sessionPermissions` ceiling.

### Revocation is per credential

The admitting `credentialId` is recorded on the `PendingConnection` and on each socket (including sockets that resume an existing session). Revoke removes the record, then closes every socket admitted with that id and every `hostLinks` entry opened over those sockets. A pending connection whose credential was revoked between admission and session creation is rejected: the store is re-checked before the session is created or resumed.

### RPCs (dotted, all gated on `access.manage` in `operation-permissions.ts`)

- `access.device_credentials.issue.request { requestId, label }` → `.response { payload: { requestId, credential: { id, secret, label, createdAt } | null, error: null | "password_not_configured" | "unsupported_principal" | "limit_reached" | "store_failed" } }`.
  - Refused when the daemon has no password: a credential minted on an open daemon would silently bypass a password set later.
- `access.device_credentials.list.request` → `.response { payload: { requestId, credentials: [{ id, label, createdAt, current }] } }` — never returns secrets or digests; `current` marks the caller's own credential.
- `access.device_credentials.revoke.request { requestId, id }` → `.response { payload: { requestId, revoked: boolean } }`. `id: "*"` revokes all. Removes the record, then closes every socket admitted with that id (close code `WS_CLOSE_DAEMON_AUTH_FAILED`, reason "Credential revoked"). Sockets admitted by password on the same session stay open.
- `daemon.get_pairing_offer.request` gains optional `includePairingToken: boolean`. When true, a password is configured and the caller passes the owner-only rule, the daemon mints a token and adds `pairingToken` to the offer. Default false keeps today's offer byte-identical.

### Offer (`connection-offer.ts`)

`ConnectionOfferV2Schema` gains optional `pairingToken: string` (min 1, max 128). Old apps ignore it (zod object strips unknown keys; verified against the current parser). Only RPC-returned offers carry it; the CLI `paseo daemon pair` path and the daemon startup log never do, so no token reaches a log file. The token is short-lived and single-use: if the QR leaks after it is used or after 10 minutes it admits nothing.

### server_info

`features.deviceCredentials: true` (optional in schema, `COMPAT(deviceCredentials)` tag).

## App

- After any admitted connection (direct with password, desktop local credential, pairing token, routed `via:<origin>`) to a host with `features.deviceCredentials` and `access.manage` in `server_info.permissions`, and no stored credential for that host, the app calls `issue` once with label `<device name> (<platform>)` and stores the result.
- Storage: `HostProfile.deviceCredential = { id, secret }` in the existing host registry (AsyncStorage key `@paseo:daemon-registry`; `StoredHostProfileSchema` gains the optional field). The app already stores the host password there in plaintext and has no secure store; a per-device, revocable credential beside it is strictly less exposure than the password, and it lets the user clear the password. Moving the registry's secrets to a secure store is a separate change (needs `expo-secure-store` and a native rebuild).
- Hello auth order: local credential (desktop, direct) → device credential → password. A stored credential proves the daemon supported the feature when it was minted. If a hello carrying it is rejected (`incorrect_password`, i.e. revoked) or closed as an invalid hello (daemon downgraded), the app drops the credential and retries once with the stored password, else shows the existing "Password required" state. This does not depend on unmerged #9122.
- Pairing: scanning an offer with `pairingToken` sends `{ kind: "pairingToken" }` on the first hello, then mints a device credential immediately. The token is never persisted in `HostProfile`.
- Routed hosts: once the origin is admitted, each routed host is admitted through the origin's link; the app mints a credential on each, so the phone can later reach them directly over relay without the origin.
- Settings → host: list this host's devices and revoke one (uses list/revoke RPCs).

## Compatibility

- New hello auth kinds extend a discriminated union. An old daemon rejects a hello whose `auth.kind` it does not know as invalid; the app holds a device credential only for a host that issued one (so it advertised `features.deviceCredentials`), drops it if a downgraded daemon closes the hello as invalid, and sends a pairing token only from an offer that carried one (only a capable daemon emits it).
- All new fields optional; no narrowing; no `.transform()` in wire schemas.

## Threats considered

| Threat                                 | Mitigation                                                                                                                                        |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Stolen phone                           | Revoke that device (or all) from any other trusted client.                                                                                        |
| Disk read of `device-credentials.json` | Holds only SHA-256 of 256-bit secrets; not reversible.                                                                                            |
| QR photographed                        | Token single-use, 10 min, memory only; long-lived secret never in QR/URL.                                                                         |
| Concurrent token replay                | Token deleted synchronously before admission continues.                                                                                           |
| Relay operator                         | E2EE; relay sees ciphertext only.                                                                                                                 |
| Privilege escalation / session hijack  | Only full-owner `owner` sessions issue; every credential is full owner, so no narrower credential can resume and narrow another client's session. |
| Password set after minting             | Issue refused on a daemon without a password.                                                                                                     |
| Revoked mid-handshake                  | Store re-checked before session create/resume.                                                                                                    |
| Logs                                   | Secrets and tokens never logged; offer URLs with tokens are never logged.                                                                         |

## Tests

- Server, one failing-without-fix test: in-process daemon with a password; issue over a password session; a new hello with only the device credential is admitted; revoke closes it and a new hello is rejected. Fails on `main` (hello schema rejects the unknown auth kind).
- Unit: admission resolution (good, wrong secret, unknown id, pairing token single-use, expiry, concurrent use); owner-only refusal for a narrowed session.

## Out of scope

- `lastUsedAt` tracking (would write the store on every connect).
- Workspace-scoped grants.
- Moving host secrets (password and device credential) to an OS secure store.

## Open questions for Teo

1. Storage in `HostProfile` (plaintext AsyncStorage, same as today's password) rather than a new native secure-store dependency. Recommended: yes for this PR; secure store as a follow-up.
2. Password change does not revoke devices (binding is unsafe with `PASEO_PASSWORD` re-hashing); revoke-all is the lever. Recommended: accept.
3. Only the desktop Pair device screen requests a pairing token; `paseo daemon pair` (CLI) stays token-free so no token lands in terminal scrollback or logs. Recommended: accept.

# TH1-2410 implementation brief (Sol)

Implement `handoffs/TH1-2410/SPEC.md` in this worktree on branch `th1-2410-device-credentials`. Security lane. Read first: `CLAUDE.md`, `packages/server/CLAUDE.md`, `docs/permissions.md`, `docs/protocol-compatibility.md`, `docs/rpc-namespacing.md`, `docs/protocol-validation.md`, `docs/testing.md`, `docs/coding-standards.md`.

## Hard limits

- Never read files under `~/.paseo`, `~/.claude*`, `~/.codex*`, `~/.hermes`. Never touch port 6767 or restart any daemon. No `npm install` of new dependencies. Do not push, open PRs or merge.
- Never run the full suite. Run only the test files you change: `cd packages/server && npx vitest run <file> --bail=1`.
- Run `npm run build:client` after protocol changes (regenerates validators and declarations), then `npm run typecheck`, `npm run lint`, `npm run format`.
- Comments: at most 2 lines each; no new file over 300 lines.

## Map (verified)

- Hello auth union: `packages/protocol/src/messages.ts` ~8107 (`WSHelloMessageSchema.auth`). Add `deviceCredential {id (1..64), secret (1..128)}` and `pairingToken {token (1..128)}`. `WSHelloRejectedMessageSchema` stays unchanged.
- `server_info.features`: `ServerInfoStatusPayloadSchema` ~3897; add `deviceCredentials: z.boolean().optional()` with `// COMPAT(deviceCredentials): added in v0.15.4, remove gate after 2027-05-09.`; populate in `websocket-server.ts` `buildServerInfoStatusPayload` (~2014).
- RPC schemas: request in `SessionInboundMessageSchema` (~3495), response in `SessionOutboundMessageSchema` (~7364), responses wrap fields in `payload`. Follow `daemon.get_pairing_offer.*` (1530, 5532). Add `access.device_credentials.{issue,list,revoke}.{request,response}`; add optional `includePairingToken: z.boolean().optional()` to `daemon.get_pairing_offer.request`.
- Permission maps (exhaustive, compile-enforced): `packages/server/src/server/authorization/operation-permissions.ts`; all new request/response types → `"access.manage"`.
- Dispatch: `packages/server/src/server/session.ts` ~3211 switch; handlers in `session/daemon/daemon-session.ts` (pattern at 232). The handler needs the caller's principal, permissions, and the admitting credential id of the requesting socket; plumb a narrow interface from `websocket-server.ts` into the session rather than reaching into it.
- Offer schema: `packages/protocol/src/connection-offer.ts` add `pairingToken: z.string().min(1).max(128).optional()` with a COMPAT comment; `packages/server/src/server/connection-offer.ts` + `pairing-offer.ts` accept an optional token. CLI `packages/cli/src/commands/daemon/pair.ts` never requests one.
- Admission: `packages/server/src/server/session-admission-auth.ts`; caller `websocket-server.ts` `admitPendingHello` (~1885). `SessionAdmission` (~155) gains optional `credentialId`. `PendingConnection` (~161). `resumeSession` (~1955), session creation (~1826), `hostLinks` (~2673), `updatePrincipalPermissions` (~1125) as a model for closing.
- Persistence model: `packages/server/src/server/hub/relationship-controller.ts` (load/quarantine/persist), helpers `packages/server/src/server/private-files.ts` (`writePrivateFileAtomic`). New module e.g. `packages/server/src/server/device-credentials.ts` (store + pairing tokens), constructed in `bootstrap.ts` and passed into `VoiceAssistantWebSocketServer` (constructor is positional; add it next to `daemonAuth`).
- Local credential compare reference: `packages/server/src/server/local-credential.ts`.
- Tests: extend `packages/server/src/server/bootstrap-auth.test.ts` (uses `createTestPaseoDaemon({auth:{password: hash}})` and `DaemonClient` from `@getpaseo/client/internal/daemon-client`). Add one new test there that fails on main: password daemon; client authenticated by password issues a credential; a fresh client with only `{kind:"deviceCredential"}` connects; revoke closes it; a new hello with it is rejected. Add a small unit test file for the store/admission (good, wrong secret, unknown id, token single-use incl. two concurrent resolves, expiry with injected clock, owner-only refusal for narrowed permissions).
- Client: `packages/client/src/daemon-client.ts` — `chooseConnectionAuth` (~287) / `resolveConnectionAuth` (~307) / config (~448): add `deviceCredential?: {id, secret}` and `pairingToken?: string` config; order localCredential → pairingToken → deviceCredential → password. Never use a device credential or token for the legacy header/subprotocol path. Add methods `issueDeviceCredential(label)`, `listDeviceCredentials()`, `revokeDeviceCredential(id)` via `sendCorrelatedSessionRequest` (~2417, example `addHost` ~1902), gated on `features.deviceCredentials`. Extend `getPairingOffer` with `includePairingToken`.
- App: `packages/app/src/types/host-connection.ts` `HostProfile` (76) + `StoredHostProfileSchema` (519, strictObject) gain optional `deviceCredential: {id, secret}`; `hasProfileChanged` (281) must compare it. `packages/app/src/runtime/host-runtime.ts`: pass `deviceCredential` in `createClient` (~596) and `connectToDaemon` (~688) beside `password`; on `"connected"` (~1522–1537) mint once if `features.deviceCredentials`, `server_info.permissions` include all owner permissions, and no credential stored; persist via `updateHost` without triggering a reconnect loop (do not bump the probe version for a credential change). On auth rejection / invalid-hello close while a credential was used: drop it, persist, retry once. Routed hosts (`createClient` ~599) pass the destination host's credential? No — routed hellos are admitted by the origin link; only mint there. Offer import (`parseOfferConnectionUrl` ~1624, `probeAndUpsertOffer` ~2194): keep `pairingToken` in memory for the first probe/connect only, never in the profile. Desktop `packages/app/src/desktop/components/pair-device-section.tsx`: request the offer with `includePairingToken: true` when the host advertises the feature, and refresh it after expiry.
- Host settings device list/revoke UI (`packages/app/src/screens/settings/host-page.tsx`): implement only if it fits cleanly; otherwise leave it out and report it. Follow `docs/design.md`.

## Done

- All spec behaviors implemented; the new bootstrap-auth test fails on `origin/main` code and passes here (report both runs, exact commands and results).
- `npm run build:client`, `npm run typecheck`, `npm run lint`, `npm run format` pass.
- Update `docs/permissions.md` (integrate, do not append a dump; plain short voice per CLAUDE.md) to describe device credentials and pairing tokens as built.
- Commit on the branch with a conventional message (no Co-Authored-By). Do not push.
- Report: files changed, exact command results, anything from the spec not done and why.

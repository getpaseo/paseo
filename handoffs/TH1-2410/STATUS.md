# TH1-2410 STATUS

- PR: https://github.com/getpaseo/paseo/pull/9226 (branch `th1-2410-device-credentials`). Earlier blocking findings and hardening S1-S3 are fixed and confirmed.
- 2026-11-26: fixed sayak-brm's review findings in `websocket-server.ts`. A session admitted by a device credential or pairing token now lists only itself, can revoke only its own credential, and cannot mint pairing tokens. This closes "a device revokes other devices or `*`" and "a device pairs a successor that survives revocation".
- Verification: the extended `bootstrap-auth.test.ts` "issues a device credential" test fails on b3806f7d8 (exit 1: a device revoking another credential got `revoked: true`) and passes with the fix (exit 0, 1 passed). Server typecheck, lint and format exit 0.
- Done in-session at Teo's request: dispatcher binding for TH1-2410 points at the stale `dispatch/TH1-2410`.
- Sol and security-auditor review: fixed the race where revoke-all left a socket admitted by an unused pairing invitation open and able to issue. Revoke-all now also clears unused invitations. Test fails without the fix (timeout) and passes with it (16/16).
- Open for Teo: devices hold full owner authority, so a device can still reach terminals, the local credential and Hub connect. Documented as a limit in docs/permissions.md. Narrowing device permissions is a policy decision.
- Next: same-reviewer confirmation; Teo merges.

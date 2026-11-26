# TH1-2410 STATUS

- PR: https://github.com/getpaseo/paseo/pull/9226 (branch `th1-2410-device-credentials`). Earlier blocking findings and hardening S1-S3 are fixed and confirmed.
- 2026-11-26: fixed sayak-brm's review findings in `websocket-server.ts`. A session admitted by a device credential or pairing token now lists only itself, can revoke only its own credential, and cannot mint pairing tokens. This closes "a device revokes other devices or `*`" and "a device pairs a successor that survives revocation".
- Verification: the extended `bootstrap-auth.test.ts` "issues a device credential" test fails on b3806f7d8 (exit 1: a device revoking another credential got `revoked: true`) and passes with the fix (exit 0, 1 passed). Server typecheck, lint and format exit 0.
- Done in-session at Teo's request: dispatcher binding for TH1-2410 points at the stale `dispatch/TH1-2410`.
- Next: Sol review, adversarial review and read-only security audit of this commit; Teo merges.

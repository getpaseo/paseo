# TH1-2410 STATUS

- Base PR: https://github.com/getpaseo/paseo/pull/9226 (branch `th1-2410-device-credentials`, head f9ab1a93a); blocking findings fixed and confirmed.
- Hardening branch `th1-2410-hardening` (stacked on 9226) fixes the three should-fix audit items:
  - S1: the client drops a device credential only after an in-channel `hello.rejected`; a bare close keeps it and retries once with the password.
  - S2: routed sessions (host-link `VirtualHostSocket` or `routed` hello) are not full owner, so issue and pairing-token mint refuse with `unsupported_principal`.
  - S3: list and revoke require full owner; a narrowed session gets `[]` / `revoked: false` (no protocol change).
- Verification: see the hardening PR body.
- Open: adversarial Sol review of the hardening PR; Teo merges both.

# TH1-2410 STATUS

- Base PR: https://github.com/getpaseo/paseo/pull/9226 (branch `th1-2410-device-credentials`, head f9ab1a93a); blocking findings fixed and confirmed.
- Hardening branch `th1-2410-hardening` (stacked on 9226) fixes the three should-fix audit items:
  - S1: the client drops a device credential only after an in-channel `hello.rejected`; a bare close keeps it and retries once with the password.
  - S2: routed sessions (host-link `VirtualHostSocket` or `routed` hello) are not full owner, so issue and pairing-token mint refuse with `unsupported_principal`.
  - S3: list and revoke require full owner; a narrowed session gets `[]` / `revoked: false` (no protocol change).
- Hardening PR: https://github.com/hteo1337/paseo/pull/10 (draft). Verification: see its body.
- Adversarial review (gpt-6.1-sol, separate worktree): VERDICT: APPROVE, no findings; see `REVIEW-hardening-sol.txt`. Its own test run failed on npm ci in that worktree; local runs here are green.
- Open: Teo merges both.

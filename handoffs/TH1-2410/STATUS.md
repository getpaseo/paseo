# TH1-2410 STATUS

- Branch `th1-2410-device-credentials`; commits c03e957f4 (daemon/protocol) and 22da439f6 (client/app) on spec 5c11feaa0.
- Verification: new bootstrap-auth tests fail on 5c11feaa0 code (2 failed, 14 passed) and pass on HEAD (bootstrap-auth + device-credentials: 20 passed); typecheck, lint, format pass.
- Next: Sol review, adversarial review, security-auditor; then draft PR. Teo merges.
- Decisions: owner-only issuing, full-owner credentials, no password binding, credential stored in HostProfile.
- Open: Teo's review of the spec's three questions. No merge, no daemon restart.

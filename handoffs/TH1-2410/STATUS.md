# TH1-2410 STATUS

- Branch `th1-2410-device-credentials`; commits c03e957f4 (daemon/protocol) and 22da439f6 (client/app) on spec 5c11feaa0.
- Verification: new bootstrap-auth tests fail on 5c11feaa0 code (2 failed, 14 passed) and pass on HEAD (bootstrap-auth + device-credentials: 20 passed); typecheck, lint, format pass.
- PR: https://github.com/getpaseo/paseo/pull/9226 (draft, head 71aa971a0); reviews done, all blocking findings fixed and confirmed.
- Decisions: owner-only issuing, full-owner credentials, no password binding, credential stored in HostProfile.
- Open: Teo spec review + merge; follow-ups: forged-close credential wipe, routed Hub minting, owner-only revoke/list.

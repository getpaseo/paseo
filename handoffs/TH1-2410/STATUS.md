# TH1-2410 STATUS

- Branch `th1-2410-device-credentials` on upstream main ab64bebe1; supersedes hteo1337/paseo#9 (stale base, different model).
- Done: spec (handoffs/TH1-2410/SPEC.md, Linear document on TH1-2410), sent to Teo for review.
- Next: Sol implements protocol + daemon + test, then client + app; Opus reviews; adversarial + security-auditor review; draft PR.
- Decisions: owner-only issuing, full-owner credentials, no password binding (PASEO_PASSWORD rehash), credential in HostProfile.
- Open: Teo's answers to the spec's three questions. No merge, no daemon restart.

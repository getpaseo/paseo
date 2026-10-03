# KIN-001 evidence (pipeline-visible copy)

Work item: KIN-001 — Inventory and pin real workspace.
Factory worktree: `team-6ffe9a-kin-001` (this checkout). Canonical product
evidence lives in the Kin monorepo on branch `task/KIN-001-inventory`
(commits `2d51459`, `3a1e242`, `cb33d8a`, plus the 3rd-pass commit listed in
`summary.md`); this directory mirrors that record with the executed build and
check logs so reviewers see them here without cross-repo reads.

Contents: `summary.md` (inventory + review-response record), `toolchain-pin.md`
(pinned versions with sources), `android-sdk-inventory.md`,
`mac-toolchain-inventory.md`, `logs/` (Android APK and iOS Simulator build
transcripts, host toolchain transcript, four reference-check transcripts, and
Mac transcript — `.txt` because this repo git-ignores `*.log`; the Kin-monorepo
mirror keeps the same content as `.log`).

Deliberately NOT in this commit: `environment.local.md` (gitignored by design —
may one day hold founder answers; lives only in the Kin worktree), the APK
binary (regenerable via `flutter build apk --debug`), any secret, key, token,
cookie, or portal session material.

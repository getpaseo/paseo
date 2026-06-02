---
name: release-beta
description: Cut a beta release of Paseo. Use when the user says "release beta", "cut a beta", "ship a beta", "beta release", or "/release-beta". Betas are silent release candidates — no changelog, no website move, npm only on the beta dist-tag.
user-invocable: true
---

# Release beta

Read `docs/release.md` in the Paseo repo and follow the **Beta flow** section end-to-end. Run the **Beta release** completion checklist at the bottom of that doc.

Key rules the doc enforces — betas don't touch `CHANGELOG.md`, don't draft release notes, and publish npm only with the explicit `beta` dist-tag.

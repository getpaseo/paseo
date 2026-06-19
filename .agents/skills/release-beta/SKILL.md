---
name: release-beta
description: Cut a beta release of Paseo. Use when the user says "release beta", "cut a beta", "ship a beta", "beta release", or "/release-beta". Betas are release candidates on the beta channel — they carry an in-place changelog entry, don't move the website download target, and publish npm only on the beta dist-tag.
user-invocable: true
---

# Release beta

Read `docs/release.md` in the Paseo repo and follow the **Beta flow** section end-to-end. Run the **Beta release** completion checklist at the bottom of that doc.

Key rules the doc enforces — each beta updates an in-place `CHANGELOG.md` entry (`## X.Y.Z-beta.N`) that gets overwritten at promotion (never leave a stale `-beta.N` heading behind), and betas publish npm only with the explicit `beta` dist-tag.

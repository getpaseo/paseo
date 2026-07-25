---
name: release-stable
description: Cut a stable release of Paseo (fresh patch or minor, or promote from beta). Use when the user says "release stable", "ship stable", "promote", "release:patch", "release:minor", "release:promote", or "/release-stable".
user-invocable: true
---

# Release stable

Read `docs/release.md` in the Paseo repo and follow the **Standard release (stable)** flow if cutting fresh, or the **Beta flow** promotion step if promoting an existing beta. Run the **Stable release (or promotion)** completion checklist at the bottom of that doc.

For a fresh release, classify the previous-stable-to-`HEAD` diff as patch or minor and show the target version and rationale to the user. Agents never select a major version autonomously.

The doc covers the changelog, pre-release sanity check, and post-release babysit pattern. Don't skip steps.

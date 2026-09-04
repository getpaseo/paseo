---
name: fork
description: Explains why this repo is a permanent fork of getpaseo/paseo, what the project-groups feature adds, and the three commits that stop the fork erasing itself. Use when someone asks why this diverges from upstream, whether to send something upstream or make it a plugin, why the version is 1.x, how to build or install the desktop app, why the update feed points at totally-tim, or what breaks if the upstream app is opened again.
user-invocable: true
---

# The team fork

Read `docs/fork.md` before answering. It covers why the fork exists and why the feature cannot
be a plugin (both settled — do not reopen either), the three fork-config commits and what each
one protects, the shared-`appId` trap that makes reinstalling upstream destroy the sidebar
order and strip group assignments, how to build and install the desktop app, and the release
and notarization setup.

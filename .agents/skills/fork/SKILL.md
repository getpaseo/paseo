---
name: fork
description: Explains why this repo is a permanent fork of getpaseo/paseo, what it carries, how to sync upstream, and how versions and releases work. Use when someone asks why this diverges from upstream, whether to send something upstream or make it a plugin, how to merge upstream, why the installed app says 1.x while the repo says 0.7.x, how to build, release, or install the desktop app, why the update feed points at totally-tim, or what breaks if the upstream app is opened again.
user-invocable: true
---

# The team fork

Read `docs/fork.md` before answering. It covers the ledger of fork changes and why project
groups cannot be a plugin (settled, do not reopen), the single `main` trunk, the weekly
upstream sync by release tag, why the committed version stays upstream's and the fork version
lives only in tags, the update feed, CI releases, local builds, and the shared-`appId` trap that
makes reinstalling upstream destroy the sidebar order and strip group assignments.

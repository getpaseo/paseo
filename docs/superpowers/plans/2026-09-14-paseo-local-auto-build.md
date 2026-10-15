# Paseo Local Automatic Build Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Install a macOS LaunchAgent that rebuilds Paseo Local whenever `origin/paseo-local` advances.

**Architecture:** One dependency-free Node script owns installation, removal, polling, locking, the dedicated checkout, and a harmless launchd probe. The runtime fetches only `refs/heads/paseo-local`, updates only by fast-forward, and writes its success marker only after the existing atomic `npm run build` path succeeds.

**Tech Stack:** Node.js standard library, Git, npm, macOS launchd, Vitest integration tests.

**Spec:** `docs/paseo-local-auto-build.md`

## Global Constraints

- Base and target branch is `origin/paseo-local`; never touch `main`.
- Never close or restart Paseo Local or its daemon on port 6767.
- The checkout is dedicated, stable, clean, and updated only with `git merge --ff-only`.
- A failed dependency install or build must leave the previous success marker unchanged for automatic retry.
- Installation and uninstallation are idempotent.
- Verification uses local Git fixtures and a harmless temporary LaunchAgent; it must not build the real app or contact port 6767.
- Do not commit, push, or create a pull request.

---

### Task 1: Deterministic monitor contract

**Files:**

- Create: `scripts/paseo-local-auto-build.test.mjs`
- Create: `scripts/paseo-local-auto-build.mjs`

**Interfaces:**

- Consumes: a Git remote named `origin`, branch `paseo-local`, `npm` available through the installed PATH.
- Produces: CLI commands `run`, `install`, `uninstall`, `verify-launchd`, plus exported `main(argv, env)` for the integration test.

- [x] **Step 1: Write the failing integration test**

Create real temporary Git repositories and a fake executable `npm`. Assert that `run` fast-forwards and builds a new commit, skips an already successful commit, preserves the marker after failure, retries that commit, refuses a non-fast-forward, and skips a concurrent run while the live lock exists.

- [x] **Step 2: Run the test to verify it fails**

Run: `npx vitest run scripts/paseo-local-auto-build.test.mjs --bail=1`

Expected: FAIL because `scripts/paseo-local-auto-build.mjs` does not exist.

- [x] **Step 3: Write the minimal monitor**

Use `spawnSync` with explicit argv, macOS `/usr/bin/lockf -k -t 0` for the process lock, `git fetch origin refs/heads/paseo-local:refs/remotes/origin/paseo-local`, `git merge --ff-only origin/paseo-local`, `npm ci`, and `npm run build`. Replace `last-successful-commit` through a same-directory temporary file and rename.

- [x] **Step 4: Run the focused test to verify it passes**

Run: `npx vitest run scripts/paseo-local-auto-build.test.mjs --bail=1`

Expected: all monitor cases PASS.

### Task 2: Idempotent lifecycle and real launchd probe

**Files:**

- Modify: `scripts/paseo-local-auto-build.test.mjs`
- Modify: `scripts/paseo-local-auto-build.mjs`
- Modify: `package.json`

**Interfaces:**

- Consumes: `main(argv, env)` and paths derived from the user home directory.
- Produces: `sh.paseo.local-auto-build.plist`, npm lifecycle commands, and a temporary `sh.paseo.local-auto-build.verify.<pid>` job.

- [x] **Step 1: Write failing lifecycle tests**

Assert plist arguments, five-minute interval, captured PATH, stable checkout creation, repeated installation, repeated uninstallation, and cleanup. Exercise a fake `launchctl` executable for deterministic install/uninstall behavior.

- [x] **Step 2: Run the test to verify it fails**

Run: `npx vitest run scripts/paseo-local-auto-build.test.mjs --bail=1`

Expected: FAIL because lifecycle commands are not implemented.

- [x] **Step 3: Implement lifecycle commands**

Generate the plist without a template dependency. Clone only `paseo-local` when the checkout is absent, validate an existing checkout, replace the plist atomically, boot out an old job when present, then bootstrap it. Uninstall by booting out first and removing the plist while retaining checkout, marker, and logs. Implement `verify-launchd` as a temporary RunAtLoad probe with bounded polling and unconditional cleanup.

- [x] **Step 4: Run focused tests and the real launchd probe**

Run: `npx vitest run scripts/paseo-local-auto-build.test.mjs --bail=1`

Run: `npm run paseo-local:auto-build:verify-launchd`

Expected: tests PASS; probe reports success and leaves no loaded verification job.

### Task 3: Documentation and repository checks

**Files:**

- Modify: `CLAUDE.md`
- Create: `docs/paseo-local-auto-build.md`
- Modify: `docs/superpowers/plans/2026-09-14-paseo-local-auto-build.md`

**Interfaces:**

- Consumes: the final command names and paths from Task 2.
- Produces: concise operating instructions, log location, retry and daemon-safety guarantees.

- [x] **Step 1: Align docs with implemented behavior**

Keep this subject in `docs/paseo-local-auto-build.md` and link it once from the docs index. Do not duplicate code-level details.

- [x] **Step 2: Run required verification**

Run: `npm run format:files -- CLAUDE.md docs/paseo-local-auto-build.md docs/superpowers/plans/2026-09-14-paseo-local-auto-build.md scripts/paseo-local-auto-build.mjs scripts/paseo-local-auto-build.test.mjs package.json`

Run: `npm run typecheck`

Run: `npm run lint`

Run: `git diff --check origin/paseo-local...HEAD` and inspect `git status --short`.

Expected: every command exits 0 and only the planned files differ.

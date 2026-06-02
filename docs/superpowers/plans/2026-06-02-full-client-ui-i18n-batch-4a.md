# Full Client UI I18n Batch 4A Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate workspace setup, file, browser, terminal, and import-session wrapper UI copy to the client i18n resources.

**Architecture:** Add grouped translation keys under existing product surfaces: `workspace`, `importSession`, and `panels`. Components import `useTranslation()` only where they own user-facing copy, while raw paths, URLs, commands, logs, provider labels, and server/runtime errors stay untranslated.

**Tech Stack:** React Native, Expo, react-i18next, Vitest resource parity tests, Biome/Oxlint.

---

### Task 1: Add Batch 4A Resource Contract

**Files:**

- Modify: `packages/app/src/i18n/resources.test.ts`
- Modify: `packages/app/src/i18n/resources/en.ts`
- Modify: `packages/app/src/i18n/resources/zh-CN.ts`

- [ ] **Step 1: Write failing resource assertions**

Add a test that references the new Batch 4A keys:

```ts
it("includes workspace and panel keys for the Batch 4A migration", () => {
  expect(en.importSession.title).toBe("Import session");
  expect(en.importSession.status.connectHost).toBe("Connect to a host to import sessions");
  expect(en.importSession.actions.refresh).toBe("Refresh sessions");
  expect(en.workspace.fileExplorer.sort.name).toBe("Name");
  expect(en.workspace.fileExplorer.empty.noFiles).toBe("No files");
  expect(en.workspace.setup.status.running).toBe("Running");
  expect(en.workspace.setup.empty.noCommands).toBe("No setup commands ran for this workspace.");
  expect(en.workspace.browser.unavailable.title).toBe("Browser is desktop-only");
  expect(en.workspace.browser.controls.enterUrl).toBe("Enter URL");
  expect(en.workspace.terminal.hostDisconnected).toBe("Host is not connected");
  expect(en.panels.file.executionDirectoryMissing).toBe("Workspace execution directory not found.");
});
```

- [ ] **Step 2: Run RED**

Run:

```bash
node node_modules/vitest/vitest.mjs run packages/app/src/i18n/resources.test.ts --bail=1
```

Expected: FAIL because `en.importSession` or another Batch 4A key is missing.

- [ ] **Step 3: Add English and Simplified Chinese resources**

Add matching `en` and `zhCN` resource groups. Keep terminology consistent with `docs/i18n.md` and `docs/glossary.md`; preserve Product terms like Host, Provider, Project, Worktree, Daemon, CLI where appropriate.

- [ ] **Step 4: Run GREEN**

Run the same resource test and confirm PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/app/src/i18n/resources.test.ts packages/app/src/i18n/resources/en.ts packages/app/src/i18n/resources/zh-CN.ts
git commit -m "feat: add workspace panel i18n resources"
```

### Task 2: Migrate Import Session Sheet

**Files:**

- Modify: `packages/app/src/components/import-session-sheet.tsx`

- [ ] **Step 1: Import and use `useTranslation()`**

Translate status messages, refresh accessibility, the `All` filter label, row importing status, and sheet title. Do not translate Provider labels, prompt previews, cwd paths, or thrown internal errors.

- [ ] **Step 2: Verify**

Run:

```bash
node node_modules/vitest/vitest.mjs run packages/app/src/i18n/resources.test.ts --bail=1
node node_modules/@typescript/native-preview/bin/tsgo.js --noEmit -p packages/app/tsconfig.json
```

- [ ] **Step 3: Commit**

```bash
git add packages/app/src/components/import-session-sheet.tsx
git commit -m "feat: translate import session chrome"
```

### Task 3: Migrate Workspace Wrapper Panels

**Files:**

- Modify: `packages/app/src/components/file-explorer-pane.tsx`
- Modify: `packages/app/src/panels/setup-panel.tsx`
- Modify: `packages/app/src/components/browser-pane.tsx`
- Modify: `packages/app/src/components/browser-pane.electron.tsx`
- Modify: `packages/app/src/components/terminal-pane.tsx`
- Modify: `packages/app/src/panels/file-panel.tsx`

- [ ] **Step 1: Translate client-owned file explorer chrome**

Translate sort labels, context menu labels, refresh accessibility labels, loading/empty/error wrapper actions, and workspace-unavailable text. Preserve file names, file paths, sizes, timestamps, and server errors.

- [ ] **Step 2: Translate setup panel chrome**

Translate descriptor labels/subtitles, command status labels, waiting/empty text, accessibility labels, and empty log text. Preserve commands, logs, durations, and snapshot errors.

- [ ] **Step 3: Translate browser and terminal wrapper chrome**

Translate browser unavailable state, browser session label, browser toolbar accessibility labels/placeholders, terminal disconnected wrapper text, and file-panel missing execution directory text. Preserve URLs, browser page titles, terminal output, and file paths.

- [ ] **Step 4: Verify**

Run:

```bash
node node_modules/vitest/vitest.mjs run packages/app/src/i18n/resources.test.ts --bail=1
node node_modules/vitest/vitest.mjs run packages/app/src/i18n/locales.test.ts --bail=1
node node_modules/@typescript/native-preview/bin/tsgo.js --noEmit -p packages/app/tsconfig.json
node_modules/oxlint/bin/oxlint
node_modules/oxfmt/bin/oxfmt packages/app/src/i18n/resources.test.ts packages/app/src/i18n/resources/en.ts packages/app/src/i18n/resources/zh-CN.ts packages/app/src/components/import-session-sheet.tsx packages/app/src/components/file-explorer-pane.tsx packages/app/src/panels/setup-panel.tsx packages/app/src/components/browser-pane.tsx packages/app/src/components/browser-pane.electron.tsx packages/app/src/components/terminal-pane.tsx packages/app/src/panels/file-panel.tsx
```

- [ ] **Step 5: Commit**

```bash
git add packages/app/src/components/file-explorer-pane.tsx packages/app/src/panels/setup-panel.tsx packages/app/src/components/browser-pane.tsx packages/app/src/components/browser-pane.electron.tsx packages/app/src/components/terminal-pane.tsx packages/app/src/panels/file-panel.tsx
git commit -m "feat: translate workspace panel chrome"
```

### Task 4: Document Progress and Update PR

**Files:**

- Modify: `docs/i18n.md`

- [ ] **Step 1: Update progress**

Add Batch 4A to the progress list and note that Batch 4B still covers workspace tab shell, Git/PR, and review surfaces.

- [ ] **Step 2: Final verification**

Run the targeted tests, app typecheck, lint, and format checks. Run the Playwright settings smoke only if updating the PR with fresh end-to-end evidence.

- [ ] **Step 3: Commit, push, and update PR**

```bash
git add docs/i18n.md docs/superpowers/plans/2026-06-02-full-client-ui-i18n-batch-4a.md
git commit -m "docs: add i18n batch 4a progress"
git push fork feat/client-i18n
```

Update PR #1282 with the Batch 4A summary and verification commands.

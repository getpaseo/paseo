# Full Client UI I18n Batch 4B Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate the remaining workspace tab shell, Git/PR, and inline review client-owned UI chrome to i18n resources.

**Architecture:** Keep resource keys grouped under `workspace.tabs`, `workspace.header`, `workspace.scripts`, `workspace.git`, and `review`. Preserve raw runtime data: branch names, PR titles/bodies, check names, file paths, diff text, script names, URLs, and server errors. Keep pure Git policy tests stable by translating action models in the React hook layer.

**Tech Stack:** React Native, Expo, react-i18next, Vitest resource parity tests, Oxlint/Oxfmt.

---

### Task 1: Add Batch 4B Resource Contract

**Files:**

- Modify: `packages/app/src/i18n/resources.test.ts`
- Modify: `packages/app/src/i18n/resources/en.ts`
- Modify: `packages/app/src/i18n/resources/zh-CN.ts`

- [x] **Step 1: Write failing resource assertions**

Add representative Batch 4B assertions:

```ts
it("includes workspace Git and review keys for the Batch 4B migration", () => {
  expect(en.workspace.tabs.actions.newAgent).toBe("New agent tab");
  expect(en.workspace.header.actions.copyPath).toBe("Copy workspace path");
  expect(en.workspace.scripts.actions.run).toBe("Run");
  expect(en.workspace.git.actions.commit.label).toBe("Commit");
  expect(en.workspace.git.diff.binaryFile).toBe("Binary file");
  expect(en.workspace.git.pr.sections.checks).toBe("Checks");
  expect(en.review.comment.placeholder).toBe("Leave a comment");
});
```

- [x] **Step 2: Run RED**

Run:

```bash
node node_modules/vitest/vitest.mjs run packages/app/src/i18n/resources.test.ts --bail=1
```

Expected: FAIL because the Batch 4B keys are missing.

- [x] **Step 3: Add English and Simplified Chinese resources**

Add full resource groups for workspace tab/header/scripts chrome, Git actions/diff/PR chrome, and inline review comments.

- [x] **Step 4: Run GREEN**

Run the same resource test and confirm PASS.

### Task 2: Migrate Workspace Tab/Header/Scripts Chrome

**Files:**

- Modify: `packages/app/src/screens/workspace/workspace-screen.tsx`
- Modify: `packages/app/src/screens/workspace/workspace-desktop-tabs-row.tsx`
- Modify: `packages/app/src/screens/workspace/workspace-tab-menu.ts`
- Modify: `packages/app/src/screens/workspace/workspace-tab-presentation.tsx`
- Modify: `packages/app/src/screens/workspace/workspace-scripts-button.tsx`

- [x] **Step 1: Translate tab labels, loading labels, switcher labels, menu entries, header actions, and scripts buttons.**

- [x] **Step 2: Preserve runtime values**

Do not translate script names, branch names, file paths, terminal ids, agent ids, or command output.

### Task 3: Migrate Git Diff/PR Chrome

**Files:**

- Modify: `packages/app/src/git/use-actions.ts`
- Modify: `packages/app/src/git/actions-split-button.tsx`
- Modify: `packages/app/src/git/diff-pane.tsx`
- Modify: `packages/app/src/git/pr-pane.tsx`
- Modify: `packages/app/src/git/pr-pane-data.ts`

- [x] **Step 1: Translate action labels in `useGitActions()` after policy output.**

- [x] **Step 2: Translate diff toolbar/status/empty wrapper text.**

- [x] **Step 3: Translate PR section titles, state labels, and activity verbs while preserving PR/user/check content.**

### Task 4: Migrate Review Chrome

**Files:**

- Modify: `packages/app/src/review/surface.tsx`

- [x] **Step 1: Translate inline review labels, placeholders, and buttons.**

### Task 5: Verify and Ship

Run:

```bash
node node_modules/vitest/vitest.mjs run packages/app/src/i18n/resources.test.ts --bail=1
node node_modules/vitest/vitest.mjs run packages/app/src/i18n/locales.test.ts --bail=1
node node_modules/vitest/vitest.mjs run packages/app/src/git/policy.test.ts --bail=1
node node_modules/vitest/vitest.mjs run packages/app/src/review/surface.test.tsx --bail=1
node node_modules/@typescript/native-preview/bin/tsgo.js --noEmit -p packages/app/tsconfig.json
node_modules/oxlint/bin/oxlint
node_modules/oxfmt/bin/oxfmt --check <touched files>
```

Then commit, push `fork feat/client-i18n`, and update PR #1282.

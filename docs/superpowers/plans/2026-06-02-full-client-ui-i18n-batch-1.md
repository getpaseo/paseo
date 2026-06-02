# Full Client UI I18n Batch 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate Paseo app shell and shared UI copy to the existing English/Simplified Chinese i18n resources.

**Architecture:** Keep the existing `i18next`/`react-i18next` app provider and resource files. Add shared `common` and `shell` keys, then migrate complete copy clusters in shared chrome components by using `useTranslation()` at the component that owns the text.

**Tech Stack:** Expo React Native, i18next, react-i18next, Vitest, Playwright, oxlint, oxfmt, TypeScript native preview (`tsgo`).

---

## File Structure

- Modify: `packages/app/src/i18n/resources/en.ts`
  - Add reusable `common.actions`, `common.states`, and `shell.commandCenter` / `shell.menu` keys.
- Modify: `packages/app/src/i18n/resources/zh-CN.ts`
  - Add matching Simplified Chinese translations.
- Modify: `packages/app/src/i18n/resources.test.ts`
  - Add assertions for the new Batch 1 keys so accidental removal is explicit, not only caught by parity.
- Modify: `packages/app/src/components/adaptive-modal-sheet.tsx`
  - Translate default Back, Close, Search, and Dismiss labels owned by the sheet.
- Modify: `packages/app/src/components/headers/back-header.tsx`
  - Translate the default Back accessibility label.
- Modify: `packages/app/src/components/headers/menu-header.tsx`
  - Translate Toggle sidebar tooltip and Open/Close menu accessibility labels.
- Modify: `packages/app/src/components/command-center.tsx`
  - Translate New agent fallback, command placeholder, No matches, Actions, and Agents labels.
- Modify: `packages/app/src/components/download-toast.tsx`
  - Translate Starting, Download complete, and Download failed fallback status text.
- Modify: `docs/i18n.md`
  - Add the staged migration order from the Batch 1 design.

---

### Task 1: Add Batch 1 Translation Keys

**Files:**

- Modify: `packages/app/src/i18n/resources/en.ts`
- Modify: `packages/app/src/i18n/resources/zh-CN.ts`
- Modify: `packages/app/src/i18n/resources.test.ts`

- [ ] **Step 1: Add explicit key assertions to the resource test**

Update `packages/app/src/i18n/resources.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { en } from "./resources/en";
import { zhCN } from "./resources/zh-CN";

function flattenKeys(value: unknown, prefix = ""): string[] {
  if (typeof value !== "object" || value === null) {
    return [prefix];
  }

  const entries = Object.entries(value);
  return entries.flatMap(([key, child]) => flattenKeys(child, prefix ? `${prefix}.${key}` : key));
}

describe("translation resources", () => {
  it("keeps Simplified Chinese keys in sync with English", () => {
    expect(flattenKeys(zhCN).sort()).toEqual(flattenKeys(en).sort());
  });

  it("includes shared shell keys for the Batch 1 migration", () => {
    expect(en.common.actions.back).toBe("Back");
    expect(en.common.actions.close).toBe("Close");
    expect(en.common.actions.dismiss).toBe("Dismiss");
    expect(en.common.actions.search).toBe("Search");
    expect(en.common.states.starting).toBe("Starting...");
    expect(en.common.states.downloadComplete).toBe("Download complete");
    expect(en.common.states.downloadFailed).toBe("Download failed");
    expect(en.shell.menu.toggleSidebar).toBe("Toggle sidebar");
    expect(en.shell.menu.open).toBe("Open menu");
    expect(en.shell.menu.close).toBe("Close menu");
    expect(en.shell.commandCenter.placeholder).toBe("Type a command or search agents...");
    expect(en.shell.commandCenter.noMatches).toBe("No matches");
    expect(en.shell.commandCenter.actions).toBe("Actions");
    expect(en.shell.commandCenter.agents).toBe("Agents");
    expect(en.shell.commandCenter.newAgent).toBe("New agent");
  });
});
```

- [ ] **Step 2: Run resource test to verify it fails**

Run:

```bash
node node_modules/vitest/vitest.mjs run packages/app/src/i18n/resources.test.ts --bail=1
```

Expected: FAIL because `common.actions`, `common.states.downloadComplete`, and `shell` keys do not exist yet.

- [ ] **Step 3: Add English keys**

In `packages/app/src/i18n/resources/en.ts`, replace the current `common` block:

```ts
common: {
  back: "Back",
  loading: "Loading...",
},
```

with:

```ts
common: {
  back: "Back",
  loading: "Loading...",
  actions: {
    back: "Back",
    close: "Close",
    dismiss: "Dismiss",
    search: "Search",
  },
  states: {
    loading: "Loading...",
    starting: "Starting...",
    downloadComplete: "Download complete",
    downloadFailed: "Download failed",
  },
},
```

Then insert this new `shell` block immediately after `common` and before `settings`:

```ts
shell: {
  menu: {
    toggleSidebar: "Toggle sidebar",
    open: "Open menu",
    close: "Close menu",
  },
  commandCenter: {
    placeholder: "Type a command or search agents...",
    noMatches: "No matches",
    actions: "Actions",
    agents: "Agents",
    newAgent: "New agent",
  },
},
```

- [ ] **Step 4: Add Simplified Chinese keys**

In `packages/app/src/i18n/resources/zh-CN.ts`, replace the current `common` block:

```ts
common: {
  back: "返回",
  loading: "加载中...",
},
```

with:

```ts
common: {
  back: "返回",
  loading: "加载中...",
  actions: {
    back: "返回",
    close: "关闭",
    dismiss: "关闭",
    search: "搜索",
  },
  states: {
    loading: "加载中...",
    starting: "正在开始...",
    downloadComplete: "下载完成",
    downloadFailed: "下载失败",
  },
},
```

Then insert this new `shell` block immediately after `common` and before `settings`:

```ts
shell: {
  menu: {
    toggleSidebar: "切换侧边栏",
    open: "打开菜单",
    close: "关闭菜单",
  },
  commandCenter: {
    placeholder: "输入命令或搜索 Agent...",
    noMatches: "没有匹配项",
    actions: "操作",
    agents: "Agents",
    newAgent: "新建 Agent",
  },
},
```

Preserve product terms `Agent` and `Agents` per `docs/glossary.md`.

- [ ] **Step 5: Run resource test**

Run:

```bash
node node_modules/vitest/vitest.mjs run packages/app/src/i18n/resources.test.ts --bail=1
```

Expected: PASS.

- [ ] **Step 6: Commit resources**

Run:

```bash
git add packages/app/src/i18n/resources/en.ts packages/app/src/i18n/resources/zh-CN.ts packages/app/src/i18n/resources.test.ts
git commit -m "feat: add shared app shell translations"
```

---

### Task 2: Migrate Shared Sheet And Header Chrome

**Files:**

- Modify: `packages/app/src/components/adaptive-modal-sheet.tsx`
- Modify: `packages/app/src/components/headers/back-header.tsx`
- Modify: `packages/app/src/components/headers/menu-header.tsx`

- [ ] **Step 1: Migrate adaptive sheet defaults**

In `packages/app/src/components/adaptive-modal-sheet.tsx`, add:

```ts
import { useTranslation } from "react-i18next";
```

Inside `SheetHeaderView`, add:

```ts
const { t } = useTranslation();
```

Replace:

```tsx
accessibilityLabel={back?.accessibilityLabel ?? back?.label ?? "Back"}
```

with:

```tsx
accessibilityLabel={back?.accessibilityLabel ?? back?.label ?? t("common.actions.back")}
```

Replace:

```tsx
<Pressable accessibilityLabel="Close" style={styles.closeButton} onPress={onClose}>
```

with:

```tsx
<Pressable
  accessibilityLabel={t("common.actions.close")}
  style={styles.closeButton}
  onPress={onClose}
>
```

Replace:

```tsx
placeholder={search.placeholder ?? "Search"}
```

with:

```tsx
placeholder={search.placeholder ?? t("common.actions.search")}
```

- [ ] **Step 2: Migrate inline sheet defaults**

Inside `InlineHeaderView`, add:

```ts
const { t } = useTranslation();
```

Replace the inline back fallback:

```tsx
accessibilityLabel={back?.accessibilityLabel ?? back?.label ?? "Back"}
```

with:

```tsx
accessibilityLabel={back?.accessibilityLabel ?? back?.label ?? t("common.actions.back")}
```

Replace:

```tsx
placeholder={header.search.placeholder ?? "Search"}
```

with:

```tsx
placeholder={header.search.placeholder ?? t("common.actions.search")}
```

Inside `AdaptiveModalSheet`, add:

```ts
const { t } = useTranslation();
```

Replace:

```tsx
<Pressable accessibilityLabel="Dismiss" style={ABSOLUTE_FILL_STYLE} onPress={onClose} />
```

with:

```tsx
<Pressable
  accessibilityLabel={t("common.actions.dismiss")}
  style={ABSOLUTE_FILL_STYLE}
  onPress={onClose}
/>
```

- [ ] **Step 3: Migrate BackHeader**

In `packages/app/src/components/headers/back-header.tsx`, add:

```ts
import { useTranslation } from "react-i18next";
```

Inside `BackHeader`, add:

```ts
const { t } = useTranslation();
```

Replace:

```text
accessibilityLabel="Back"
```

with:

```text
accessibilityLabel={t("common.actions.back")}
```

- [ ] **Step 4: Migrate SidebarMenuToggle**

In `packages/app/src/components/headers/menu-header.tsx`, add:

```ts
import { useTranslation } from "react-i18next";
```

Inside `SidebarMenuToggle`, add:

```ts
const { t } = useTranslation();
```

Replace:

```tsx
tooltipLabel="Toggle sidebar"
accessibilityLabel={isOpen ? "Close menu" : "Open menu"}
```

with:

```tsx
tooltipLabel={t("shell.menu.toggleSidebar")}
accessibilityLabel={isOpen ? t("shell.menu.close") : t("shell.menu.open")}
```

- [ ] **Step 5: Run resource and app typecheck**

Run:

```bash
node node_modules/vitest/vitest.mjs run packages/app/src/i18n/resources.test.ts --bail=1
node node_modules/@typescript/native-preview/bin/tsgo.js --noEmit -p packages/app/tsconfig.json
```

Expected: both PASS.

- [ ] **Step 6: Commit sheet/header migration**

Run:

```bash
git add packages/app/src/components/adaptive-modal-sheet.tsx packages/app/src/components/headers/back-header.tsx packages/app/src/components/headers/menu-header.tsx
git commit -m "feat: translate shared sheet and header chrome"
```

---

### Task 3: Migrate Command Center Copy

**Files:**

- Modify: `packages/app/src/components/command-center.tsx`

- [ ] **Step 1: Import translation hook**

In `packages/app/src/components/command-center.tsx`, add:

```ts
import { useTranslation } from "react-i18next";
```

- [ ] **Step 2: Translate agent fallback title**

Inside `CommandCenterAgentRowContent`, add:

```ts
const { t } = useTranslation();
```

Replace:

```text
{agent.title || "New agent"}
```

with:

```text
{agent.title || t("shell.commandCenter.newAgent")}
```

- [ ] **Step 3: Translate agent section label**

Inside `AgentItemsSection`, add:

```ts
const { t } = useTranslation();
```

Replace:

```tsx
<Text style={sectionLabelStyle}>Agents</Text>
```

with:

```tsx
<Text style={sectionLabelStyle}>{t("shell.commandCenter.agents")}</Text>
```

- [ ] **Step 4: Translate command center root copy**

Inside `CommandCenter`, add:

```ts
const { t } = useTranslation();
```

Replace:

```text
placeholder="Type a command or search agents..."
```

with:

```tsx
placeholder={t("shell.commandCenter.placeholder")}
```

Replace:

```tsx
<Text style={emptyTextStyle}>No matches</Text>
```

with:

```tsx
<Text style={emptyTextStyle}>{t("shell.commandCenter.noMatches")}</Text>
```

Replace:

```tsx
<Text style={sectionLabelStyle}>Actions</Text>
```

with:

```tsx
<Text style={sectionLabelStyle}>{t("shell.commandCenter.actions")}</Text>
```

- [ ] **Step 5: Run app typecheck**

Run:

```bash
node node_modules/@typescript/native-preview/bin/tsgo.js --noEmit -p packages/app/tsconfig.json
```

Expected: PASS.

- [ ] **Step 6: Commit command center migration**

Run:

```bash
git add packages/app/src/components/command-center.tsx
git commit -m "feat: translate command center chrome"
```

---

### Task 4: Migrate Download Toast Status Copy

**Files:**

- Modify: `packages/app/src/components/download-toast.tsx`

- [ ] **Step 1: Import translation types and hook**

In `packages/app/src/components/download-toast.tsx`, add:

```ts
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
```

- [ ] **Step 2: Pass translator into status helper**

Change:

```ts
function getDownloadStatusText(download: Download): string {
```

to:

```ts
function getDownloadStatusText(download: Download, t: TFunction): string {
```

Replace:

```ts
return "Starting...";
```

with:

```ts
return t("common.states.starting");
```

Replace:

```ts
if (download.status === "complete") return "Download complete";
return download.message ?? "Download failed";
```

with:

```ts
if (download.status === "complete") return t("common.states.downloadComplete");
return download.message ?? t("common.states.downloadFailed");
```

Raw `download.message` remains untranslated because it can come from lower-level download code.

- [ ] **Step 3: Use translator in component**

Inside `DownloadToast`, add:

```ts
const { t } = useTranslation();
```

Replace:

```tsx
<Text style={styles.status}>{getDownloadStatusText(activeDownload)}</Text>
```

with:

```tsx
<Text style={styles.status}>{getDownloadStatusText(activeDownload, t)}</Text>
```

- [ ] **Step 4: Run app typecheck**

Run:

```bash
node node_modules/@typescript/native-preview/bin/tsgo.js --noEmit -p packages/app/tsconfig.json
```

Expected: PASS.

- [ ] **Step 5: Commit download toast migration**

Run:

```bash
git add packages/app/src/components/download-toast.tsx
git commit -m "feat: translate download toast status"
```

---

### Task 5: Update I18n Documentation For Staged Migration

**Files:**

- Modify: `docs/i18n.md`

- [ ] **Step 1: Add migration order**

Append this section to `docs/i18n.md`:

```md
## Migration Order

Client UI translation is staged so each pass can migrate complete local copy clusters and keep reviews focused.

1. App shell and shared UI chrome: common actions, headers, sheets, command center, and client-owned toast status.
2. Composer and agent workflow: composer input, agent controls, permission prompts, plan approval, and agent panel wrapper states.
3. Settings expansion: Appearance, Shortcuts, Integrations, Permissions, Diagnostics, About, Project settings, Host settings, and provider diagnostics.
4. Workspace and panels: setup/file/browser/terminal wrapper copy, file explorer local states, import-session flows, and remaining local toast/error wrapper text.

Within a migrated surface, do not leave mixed-language neighboring labels when those labels are owned by the client. Move the whole local copy cluster together.
```

- [ ] **Step 2: Format docs file**

Run:

```bash
node_modules/oxfmt/bin/oxfmt docs/i18n.md
```

Expected: exits 0.

- [ ] **Step 3: Commit docs update**

Run:

```bash
git add docs/i18n.md
git commit -m "docs: document staged i18n migration"
```

---

### Task 6: Final Verification And PR Update

**Files:**

- All files touched in Tasks 1-5

- [ ] **Step 1: Format changed files**

Run:

```bash
node_modules/oxfmt/bin/oxfmt packages/app/src/i18n/resources/en.ts packages/app/src/i18n/resources/zh-CN.ts packages/app/src/i18n/resources.test.ts packages/app/src/components/adaptive-modal-sheet.tsx packages/app/src/components/headers/back-header.tsx packages/app/src/components/headers/menu-header.tsx packages/app/src/components/command-center.tsx packages/app/src/components/download-toast.tsx docs/i18n.md
```

Expected: exits 0.

- [ ] **Step 2: Run focused tests**

Run:

```bash
node node_modules/vitest/vitest.mjs run packages/app/src/i18n/resources.test.ts --bail=1
node node_modules/vitest/vitest.mjs run packages/app/src/i18n/locales.test.ts --bail=1
node node_modules/vitest/vitest.mjs run packages/app/src/hooks/use-settings/storage.test.ts --bail=1
```

Expected: PASS.

- [ ] **Step 3: Run app typecheck**

Run:

```bash
node node_modules/@typescript/native-preview/bin/tsgo.js --noEmit -p packages/app/tsconfig.json
```

Expected: PASS.

- [ ] **Step 4: Run lint**

Run:

```bash
node_modules/oxlint/bin/oxlint
```

Expected: PASS with 0 errors.

- [ ] **Step 5: Run existing language selector E2E**

Run:

```bash
PATH="$PWD/node_modules/.bin:$PATH" node node_modules/playwright/cli.js test packages/app/e2e/settings-i18n.spec.ts --config packages/app/playwright.config.ts --project='Desktop Chrome'
```

Expected: PASS.

If the Playwright run leaves `wrangler dev` or `expo start --web` processes from this E2E harness, identify them with:

```bash
ps -ef | rg 'wrangler dev|expo start|playwright'
```

and kill only those temporary E2E processes. Do not restart or kill the main Paseo daemon on port 6767.

- [ ] **Step 6: Commit final verification fixes if needed**

If formatting or verification required edits after the task commits, run:

```bash
git add packages/app/src/i18n/resources/en.ts packages/app/src/i18n/resources/zh-CN.ts packages/app/src/i18n/resources.test.ts packages/app/src/components/adaptive-modal-sheet.tsx packages/app/src/components/headers/back-header.tsx packages/app/src/components/headers/menu-header.tsx packages/app/src/components/command-center.tsx packages/app/src/components/download-toast.tsx docs/i18n.md
git commit -m "chore: finish app shell i18n verification"
```

If there are no remaining changes, skip this step.

- [ ] **Step 7: Push branch and update PR body**

Run:

```bash
git push fork feat/client-i18n
```

Then update PR #1282 verification notes to include the new Batch 1 migration and commands that were rerun.

---

## Self-Review Notes

- Spec coverage: this plan implements Batch 1 from `docs/superpowers/specs/2026-06-02-full-client-ui-i18n-design.md`.
- Scope: this plan intentionally does not migrate Composer, agent controls, provider diagnostics, project settings, host settings, file explorer, terminal panels, or raw service/agent text.
- Testing: this plan avoids full local test suites and uses resource parity, app typecheck, lint, and the existing targeted Settings language E2E.

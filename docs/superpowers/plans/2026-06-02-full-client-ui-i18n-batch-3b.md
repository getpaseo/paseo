# Full Client UI I18n Batch 3B Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate the remaining Settings expansion chrome for Host settings, Provider diagnostics, and Project settings to English/Simplified Chinese i18n resources.

**Architecture:** Keep `i18next`/`react-i18next` as the only translation layer. Add grouped keys under `settings.host`, `settings.providers`, and `settings.project`, then translate copy at the owning screen/component. Preserve provider/model names, project/host labels, file paths, commands, model ids, raw provider diagnostics, and raw daemon/server error text.

**Tech Stack:** Expo React Native, i18next, react-i18next, Vitest, oxlint, oxfmt, TypeScript native preview (`tsgo`).

---

## File Structure

- Modify: `packages/app/src/i18n/resources/en.ts`
  - Add Batch 3B resource groups for `settings.host`, `settings.providers`, and `settings.project`.
- Modify: `packages/app/src/i18n/resources/zh-CN.ts`
  - Add matching Simplified Chinese resources.
- Modify: `packages/app/src/i18n/resources.test.ts`
  - Add explicit assertions for representative Batch 3B keys.
- Modify: `packages/app/src/screens/settings/host-page.tsx`
  - Translate Host settings chrome: not-found/empty states, section titles, rename labels, connection removal, restart alerts, orchestration toggles, pair device row, system prompt editor, remove host confirmation, and local connection/latency labels.
- Modify: `packages/app/src/screens/settings/providers-section.tsx`
  - Translate provider list chrome: status labels, model count suffixes, accessibility labels, empty/loading states, add-provider labels, and local alert wrapper title.
- Modify: `packages/app/src/components/provider-diagnostic-sheet.tsx`
  - Translate provider diagnostic chrome: add model sheet, diagnostic sheet labels, model list empty/loading states, section headers, footer buttons, refresh labels, and local fallback error wrappers. Preserve provider labels, model labels, model ids, model descriptions, diagnostic content, and provider error strings.
- Modify: `packages/app/src/screens/project-settings-screen.tsx`
  - Translate Project settings chrome: no-target state, back links, read/write callouts, toast wrappers, group/section labels, metadata prompt labels/placeholders, script editor labels/validation, confirm dialogs, host switcher accessibility label, save/reload/retry actions, and local script fallback text. Preserve project names, host names, repo roots, command text, script names, `paseo.json`, and raw transport/provider error details.
- Modify: `docs/i18n.md`
  - Add Batch 3B progress note.

---

### Task 1: Add Batch 3B Translation Resources

**Files:**

- Modify: `packages/app/src/i18n/resources/en.ts`
- Modify: `packages/app/src/i18n/resources/zh-CN.ts`
- Modify: `packages/app/src/i18n/resources.test.ts`

- [ ] **Step 1: Add failing resource assertions**

Add a test after the Batch 3A explicit-key test:

```ts
it("includes Settings expansion keys for the Batch 3B migration", () => {
  expect(en.settings.host.connections.title).toBe("Connections");
  expect(en.settings.host.daemon.restart.title).toBe("Restart daemon");
  expect(en.settings.host.orchestration.enableTools.title).toBe("Enable Paseo tools");
  expect(en.settings.providers.title).toBe("Providers");
  expect(en.settings.providers.models.addModel).toBe("Add model");
  expect(en.settings.project.worktree.title).toBe("Worktree lifecycle hooks");
  expect(en.settings.project.scripts.actions.add).toBe("Add script");
  expect(en.settings.project.metadata.title).toBe("Metadata generation");
  expect(en.settings.project.actions.save).toBe("Save");
});
```

- [ ] **Step 2: Run resource test to verify it fails**

Run:

```bash
node node_modules/vitest/vitest.mjs run packages/app/src/i18n/resources.test.ts --bail=1
```

Expected: FAIL because Batch 3B key groups do not exist yet.

- [ ] **Step 3: Add English and Simplified Chinese resources**

Add resource groups directly under `settings`. Keep keys grouped by product surface:

```ts
host: {
  notFound: "Host not found",
  badges: { relay: "Relay", local: "Local" },
  connections: {
    title: "Connections",
    removeTitle: "Remove connection",
    removeMessage: "Remove {{name}}? This cannot be undone.",
    removeErrorTitle: "Error",
    removeErrorMessage: "Unable to remove connection",
    timeout: "Timeout",
  },
  pairDevices: {
    title: "Pair devices",
    rowTitle: "Pair a device",
    rowHint: "Scan a QR code or copy a link to connect your phone to this host",
  },
  orchestration: {
    title: "Orchestration",
    unavailable: "Connect to this host to manage orchestration",
    enableTools: {
      title: "Enable Paseo tools",
      hint: "Agents will be able to manage worktrees, agents and schedules",
      accessibilityLabel: "Inject Paseo tools",
    },
    systemPrompt: {
      title: "System prompt",
      hint: "Adds a system prompt to all agents",
      sheetTitle: "Append system prompt",
      accessibilityLabel: "Append system prompt",
      placeholder: "Always keep replies concise.",
    },
  },
  daemon: {
    rename: {
      editLabel: "Edit label",
      title: "Rename host",
      placeholder: "My Host",
    },
    restart: {
      title: "Restart daemon",
      hint: "Restarts the daemon process. The app will reconnect automatically",
      confirmTitle: "Restart {{name}}",
      confirmMessage:
        "This will restart the daemon. Agents running on it will keep going; the app will reconnect automatically.",
      restarting: "Restarting...",
      unableToReconnectTitle: "Unable to reconnect",
      unableToReconnectMessage: "{{name}} did not come back online. Please verify it restarted.",
      unavailableTitle: "Host unavailable",
      unavailableMessage:
        "This host is not connected. Wait for it to come online before restarting.",
      offlineTitle: "Host offline",
      offlineMessage:
        "This host is offline. Paseo reconnects automatically—wait until it's back online before restarting.",
      requestFailedTitle: "Error",
      requestFailedMessage:
        "Failed to send the restart request. Paseo reconnects automatically—try again once the host shows as online.",
      dialogFailedMessage: "Unable to open the restart confirmation dialog.",
    },
    dangerZone: "Danger zone",
    remove: {
      title: "Remove host",
      hint: "Removes this host and its saved connections from this device",
      confirmMessage: "Remove {{name}}? This will delete its saved connections.",
      errorTitle: "Error",
      errorMessage: "Unable to remove host",
    },
  },
},
providers: {
  title: "Providers",
  addProvider: "Add provider",
  providerDetails: "{{name}} provider details",
  enableProvider: "Enable {{name}}",
  unavailable: "Connect to this host to see providers",
  loading: "Loading...",
  updateErrorTitle: "Unable to update provider",
  statuses: {
    disabled: "Disabled",
    loading: "Loading",
    error: "Error",
    available: "Available",
    notInstalled: "Not installed",
  },
  models: {
    one: "1 model",
    many: "{{count}} models",
    addModel: "Add model",
    addCustomTitle: "Add custom model",
    modelId: "Model ID",
    modelIdPlaceholder: "e.g. openai/gpt-5",
    add: "Add",
    adding: "Adding…",
    failedToSave: "Failed to save model",
    removeModel: "Remove {{id}}",
    searchPlaceholder: "Search models",
    loading: "Loading models…",
    retry: "Retry",
    retrying: "Retrying…",
    noSearchMatches: "No models match your search",
    noneDetected: "No models detected",
    discovered: "Discovered",
    custom: "Custom models",
    updated: "Updated {{time}}",
  },
  diagnostic: {
    title: "Diagnostic",
    button: "Diagnostic",
    refresh: "Refresh",
    refreshing: "Refreshing…",
    refreshAccessibility: "Refresh diagnostic",
    refreshingAccessibility: "Refreshing diagnostic",
    running: "Running diagnostic…",
    none: "No diagnostic available",
    failedToFetch: "Failed to fetch diagnostic",
    unknownError: "Unknown error",
  },
},
project: {
  noEditableTarget: "We don't have an editable copy of this project on any connected host.",
  backToProjects: "Back to projects",
  switchHost: "Switch host",
  rename: {
    renamedToast: "Project renamed",
    errorFallback: "Couldn't rename project",
    renameLabel: "Rename project",
    resetLabel: "Reset project name to default",
    projectNameLabel: "Project name",
    saveLabel: "Save project name",
    cancelLabel: "Cancel renaming",
    reset: "Reset",
  },
  readFailures: {
    invalidTitle: "paseo.json couldn't be parsed",
    invalidDescription: "Fix the file on disk, then reload.",
    missingTitle: "This host doesn't have this project",
    missingWithHosts: "Switch to another host above, or reload.",
    missingSingleHost: "The selected host has no record of this project.",
    transportTitle: "Couldn't load paseo.json",
    transportFallback: "The host didn't respond.",
    failedTitle: "Couldn't load paseo.json",
    failedDescription: "Reload to try again.",
  },
  worktree: {
    title: "Worktree lifecycle hooks",
    info: "Commands that run when a worktree is created or torn down for this project",
    docs: "Docs",
    docsTooltip:
      "See docs for more details and the environment variables available to these commands",
    setup: "Setup",
    setupAccessibility: "Worktree setup commands",
    teardown: "Teardown",
    teardownAccessibility: "Worktree teardown commands",
  },
  scripts: {
    title: "Scripts",
    info: "Long-running services and one-off commands you can launch from any agent in this project",
    empty: "No scripts yet.",
    untitled: "Untitled script",
    port: "port {{port}}",
    menuAccessibility: "Open script menu",
    removeTitle: "Remove script?",
    removeMessage: "Remove {{name}}?",
    removeFallbackName: "this script",
    name: "Name",
    command: "Command",
    nameAccessibility: "Script name",
    commandAccessibility: "Script command",
    nameRequired: "Name is required",
    commandRequired: "Command is required",
    newScript: "New script",
    editScript: "Edit {{name}}",
    runAsService: "Run as a service",
    serviceHint: "Paseo supervises the process and assigns a port via $PASEO_PORT",
    actions: {
      add: "Add script",
      edit: "Edit",
      remove: "Remove",
    },
  },
  metadata: {
    title: "Metadata generation",
    info:
      "Project-specific instructions injected into the AI prompts Paseo uses to generate metadata — use them to enforce your team's conventions like branch naming, commit style, or PR format",
    agentTitle: "Agent titles",
    agentTitlePlaceholder: "Keep titles imperative and under 40 characters",
    branchName: "Branch names",
    branchNamePlaceholder: "Prefix branches with feat/ or fix/, mb/ for personal branches",
    commitMessage: "Commit messages",
    commitMessagePlaceholder: "Use Conventional Commits with a scope",
    pullRequest: "Pull requests",
    pullRequestPlaceholder: "Lead with a one-paragraph summary, include a Test plan section",
  },
  writeFailures: {
    staleTitle: "Config changed on disk",
    staleDescription: "Reload to fetch the latest paseo.json before saving.",
    failedTitle: "Couldn't save paseo.json",
    failedDescription: "Try again, or reload the latest version from disk.",
  },
  actions: {
    reload: "Reload",
    tryAgain: "Try again",
    save: "Save",
    saving: "Saving…",
    cancel: "Cancel",
  },
},
```

Use equivalent Simplified Chinese copy in `zh-CN.ts`. Preserve glossary terms Agent, Host, Project, Provider, Model, Worktree, Daemon, CLI, and `paseo.json` where that improves clarity.

- [ ] **Step 4: Run resource test**

Run:

```bash
node node_modules/vitest/vitest.mjs run packages/app/src/i18n/resources.test.ts --bail=1
```

Expected: PASS.

- [ ] **Step 5: Format/lint and commit**

Run:

```bash
node_modules/oxfmt/bin/oxfmt packages/app/src/i18n/resources/en.ts packages/app/src/i18n/resources/zh-CN.ts packages/app/src/i18n/resources.test.ts
node_modules/oxlint/bin/oxlint packages/app/src/i18n/resources/en.ts packages/app/src/i18n/resources/zh-CN.ts packages/app/src/i18n/resources.test.ts
git add packages/app/src/i18n/resources/en.ts packages/app/src/i18n/resources/zh-CN.ts packages/app/src/i18n/resources.test.ts
git commit -m "feat: add settings batch 3b translations"
```

---

### Task 2: Translate Host Settings and Provider Diagnostics Chrome

**Files:**

- Modify: `packages/app/src/screens/settings/host-page.tsx`
- Modify: `packages/app/src/screens/settings/providers-section.tsx`
- Modify: `packages/app/src/components/provider-diagnostic-sheet.tsx`

- [ ] **Step 1: Migrate `host-page.tsx`**

Import `useTranslation` and `TFunction`. Replace local UI copy with `t()` calls for Host settings. Keep host labels, connection labels, daemon versions, latency values, provider errors, and raw connection errors unchanged.

- [ ] **Step 2: Migrate `providers-section.tsx`**

Import `useTranslation` and `TFunction`. Change `getProviderStatus` to accept `t: TFunction` and return translated labels. Translate model-count labels with `settings.providers.models.one/many`; keep provider labels and provider error strings unchanged.

- [ ] **Step 3: Migrate `provider-diagnostic-sheet.tsx`**

Import `useTranslation`. Translate sheet headers, button labels, placeholder text, empty/loading states, section headers, footer metadata wrapper, and fallback errors. Keep provider label, model id/label/description, diagnostic content, provider raw error, and `formatTimeAgo` output unchanged.

- [ ] **Step 4: Verify Host/Provider migration**

Run:

```bash
node node_modules/@typescript/native-preview/bin/tsgo.js --noEmit -p packages/app/tsconfig.json
node_modules/oxlint/bin/oxlint packages/app/src/screens/settings/host-page.tsx packages/app/src/screens/settings/providers-section.tsx packages/app/src/components/provider-diagnostic-sheet.tsx
node_modules/oxfmt/bin/oxfmt packages/app/src/screens/settings/host-page.tsx packages/app/src/screens/settings/providers-section.tsx packages/app/src/components/provider-diagnostic-sheet.tsx
```

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add packages/app/src/screens/settings/host-page.tsx packages/app/src/screens/settings/providers-section.tsx packages/app/src/components/provider-diagnostic-sheet.tsx
git commit -m "feat: translate host settings chrome"
```

---

### Task 3: Translate Project Settings Chrome

**Files:**

- Modify: `packages/app/src/screens/project-settings-screen.tsx`

- [ ] **Step 1: Migrate static metadata definitions to key definitions**

Replace `METADATA_PROMPT_FIELDS` user-facing `title` and `placeholder` strings with `titleKey` and `placeholderKey`, keeping `sectionTestID` and `inputTestID` unchanged.

- [ ] **Step 2: Migrate component copy**

Import `useTranslation` and `TFunction`. Translate no-target state, back buttons, host switcher accessibility label, read/write callouts, toast wrappers, worktree/script/metadata group labels, docs link labels/tooltips, script row menu, script edit modal, validation labels, save/reload/retry actions, and project rename accessibility labels. Keep project names, host names, repo roots, script names, script command text, raw transport error details, and `paseo.json` unchanged.

- [ ] **Step 3: Verify Project migration**

Run:

```bash
node node_modules/@typescript/native-preview/bin/tsgo.js --noEmit -p packages/app/tsconfig.json
node_modules/oxlint/bin/oxlint packages/app/src/screens/project-settings-screen.tsx
node_modules/oxfmt/bin/oxfmt packages/app/src/screens/project-settings-screen.tsx
```

Expected: all pass.

- [ ] **Step 4: Commit**

```bash
git add packages/app/src/screens/project-settings-screen.tsx
git commit -m "feat: translate project settings chrome"
```

---

### Task 4: Document and Verify Batch 3B

**Files:**

- Modify: `docs/i18n.md`

- [ ] **Step 1: Update progress docs**

Append this progress note:

```md
- Batch 3B migrated Host settings, Provider diagnostics, and Project settings chrome. Provider/model names, project/host labels, script commands, diagnostic output, file paths, and raw runtime/server error details remain untranslated.
```

- [ ] **Step 2: Run final verification**

Run:

```bash
node node_modules/vitest/vitest.mjs run packages/app/src/i18n/resources.test.ts --bail=1
node node_modules/vitest/vitest.mjs run packages/app/src/i18n/locales.test.ts --bail=1
node node_modules/vitest/vitest.mjs run packages/app/src/keyboard/keyboard-shortcuts.test.ts --bail=1
node node_modules/@typescript/native-preview/bin/tsgo.js --noEmit -p packages/app/tsconfig.json
node_modules/oxlint/bin/oxlint
node_modules/oxfmt/bin/oxfmt docs/i18n.md packages/app/src/i18n/resources/en.ts packages/app/src/i18n/resources/zh-CN.ts packages/app/src/i18n/resources.test.ts packages/app/src/screens/settings/host-page.tsx packages/app/src/screens/settings/providers-section.tsx packages/app/src/components/provider-diagnostic-sheet.tsx packages/app/src/screens/project-settings-screen.tsx
PATH="$PWD/node_modules/.bin:$PATH" node node_modules/playwright/cli.js test packages/app/e2e/settings-i18n.spec.ts --config packages/app/playwright.config.ts --project='Desktop Chrome'
```

Expected: all pass. If Playwright starts temporary e2e daemon/Metro/wrangler processes, allow its teardown to stop only those temporary processes.

- [ ] **Step 3: Commit docs and push**

```bash
git add docs/i18n.md
git commit -m "docs: update i18n batch 3b progress"
git push fork feat/client-i18n
```

- [ ] **Step 4: Update PR**

Update PR #1282 body while preserving the template sections:

- Linked issue
- Type of change
- What does this PR do
- How did you verify it
- Checklist

Add Batch 3B to scope, summarize Host settings/Provider diagnostics/Project settings migration, and include the final verification commands. Leave screenshots/video unchecked unless screenshots or video were actually attached.

---

## Self-Review

- Spec coverage: Covers the remaining Batch 3 Settings expansion surfaces named in `docs/i18n.md`: Host settings, Project settings, and provider diagnostics.
- Scope: Does not migrate workspace/panel/file/browser/terminal/import-session copy; those remain Batch 4.
- Translation boundary: Preserves raw runtime/server/provider diagnostics, commands, file paths, model ids, provider labels, project names, and host labels.
- Verification: Uses targeted tests and app typecheck/lint/format. Does not run the full local test suite.

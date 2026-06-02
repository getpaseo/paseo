# Full Client UI I18n Batch 3A Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate Settings expansion chrome for the main Settings page, Appearance, Shortcuts, Integrations, and Desktop Permissions to English/Simplified Chinese i18n resources.

**Architecture:** Keep `i18next`/`react-i18next` as the single app translation layer. Add grouped resource keys under `settings.diagnostics`, `settings.about`, `settings.appearance`, `settings.shortcuts`, `settings.integrations`, and `settings.permissions`, then translate text at the owning component. Keep raw runtime status/error details, provider/model names, version strings, file paths, command strings, and OS permission detail strings unchanged unless they are locally owned wrapper labels.

**Tech Stack:** Expo React Native, i18next, react-i18next, Vitest, oxlint, oxfmt, TypeScript native preview (`tsgo`).

---

## File Structure

- Modify: `packages/app/src/i18n/resources/en.ts`
  - Add Batch 3A resource groups for Settings Diagnostics/About/Appearance/Shortcuts/Integrations/Permissions.
- Modify: `packages/app/src/i18n/resources/zh-CN.ts`
  - Add matching Simplified Chinese resources.
- Modify: `packages/app/src/i18n/resources.test.ts`
  - Add explicit assertions for representative Batch 3A keys, plus existing parity coverage.
- Modify: `packages/app/src/screens/settings-screen.tsx`
  - Translate Diagnostics, About, connected-host wrapper labels, release channel/update local labels, update confirmation copy, and playback failure wrapper prefix. Preserve `statusText`, update error messages, host labels, and version strings.
- Modify: `packages/app/src/screens/settings/appearance/appearance-section.tsx`
  - Translate Appearance section titles, theme labels, font labels/hints/accessibility labels, system-default placeholder, and highlight-theme wrapper labels. Preserve syntax theme option labels from `@getpaseo/highlight`.
- Modify: `packages/app/src/screens/settings/appearance/appearance-preview.tsx`
  - Translate preview accessibility label.
- Modify: `packages/app/src/keyboard/keyboard-shortcuts.ts`
  - Return stable section/row label keys alongside existing English fallback labels from shortcut help data.
- Modify: `packages/app/src/screens/settings/keyboard-shortcuts-section.tsx`
  - Translate Shortcuts section titles, shortcut action labels, and local controls: Press shortcut, Done, Cancel, Rebind, Reset, Reset all, desktop-only notice.
- Modify: `packages/app/src/desktop/components/integrations-section.tsx`
  - Translate Integrations local chrome and confirmation copy. Preserve skill names, CLI docs URLs, skill operation names, and filesystem paths.
- Modify: `packages/app/src/desktop/components/desktop-permissions-section.tsx`
  - Translate Desktop Permissions section title, row titles, refresh/test labels, and refresh accessibility label. Preserve raw `testNotificationError`.
- Modify: `packages/app/src/desktop/components/desktop-permission-row.tsx`
  - Translate Granted, Requesting, Request, and busy extra-action suffix via injected labels.
- Modify: `docs/i18n.md`
  - Add Batch 3A progress note.

---

### Task 1: Add Batch 3A Translation Resources

**Files:**

- Modify: `packages/app/src/i18n/resources/en.ts`
- Modify: `packages/app/src/i18n/resources/zh-CN.ts`
- Modify: `packages/app/src/i18n/resources.test.ts`

- [ ] **Step 1: Add failing resource assertions**

Add this test after the Batch 2 explicit-key test in `packages/app/src/i18n/resources.test.ts`:

```ts
it("includes Settings expansion keys for the Batch 3A migration", () => {
  expect(en.settings.diagnostics.title).toBe("Diagnostics");
  expect(en.settings.about.title).toBe("About");
  expect(en.settings.about.releaseChannel.label).toBe("Release channel");
  expect(en.settings.appearance.theme.title).toBe("Theme");
  expect(en.settings.appearance.fonts.interfaceFont).toBe("Interface font");
  expect(en.settings.shortcuts.actions.rebind).toBe("Rebind");
  expect(en.settings.integrations.commandLine.title).toBe("Command line");
  expect(en.settings.integrations.skills.updateAvailable).toBe("Update available");
  expect(en.settings.permissions.notifications).toBe("Notifications");
  expect(en.settings.permissions.actions.request).toBe("Request");
});
```

- [ ] **Step 2: Run resource test to verify it fails**

Run:

```bash
node node_modules/vitest/vitest.mjs run packages/app/src/i18n/resources.test.ts --bail=1
```

Expected: FAIL because Batch 3A key groups do not exist yet.

- [ ] **Step 3: Add English resource groups**

Extend the existing `settings` object in `packages/app/src/i18n/resources/en.ts` with:

```ts
diagnostics: {
  title: "Diagnostics",
  testAudio: "Test audio",
  playTest: "Play test",
  playing: "Playing...",
  playbackFailed: "Playback failed: {{message}}",
},
about: {
  title: "About",
  appVersion: "App version",
  thisDevice: "This device",
  connectedHosts: "Connected hosts",
  offline: "Offline",
  versionDiffers: "Version differs from this device",
  releaseChannel: {
    label: "Release channel",
    description: "Switch to Beta to get updates sooner and help shape them",
    stable: "Stable",
    beta: "Beta",
  },
  updates: {
    label: "App updates",
    readyToInstall: "Ready to install: {{version}}",
    installTitle: "Install desktop update",
    installMessage: "This updates Paseo on this computer",
    installConfirm: "Install update",
    update: "Update",
    updateTo: "Update to {{version}}",
    installing: "Installing...",
    check: "Check",
    checking: "Checking...",
    alertTitle: "Error",
    alertMessage: "Unable to open the update confirmation dialog.",
  },
},
appearance: {
  theme: {
    title: "Theme",
    accessibilityLabel: "Theme: {{value}}",
    options: {
      light: "Light",
      dark: "Dark",
      zinc: "Zinc",
      midnight: "Midnight",
      claude: "Claude",
      ghostty: "Ghostty",
      auto: "System",
    },
  },
  fonts: {
    title: "Fonts",
    systemDefault: "System default",
    interfaceFont: "Interface font",
    interfaceFontHint: "Used across the app. Leave empty for the system default",
    interfaceFontAccessibility: "Interface font family",
    interfaceSize: "Interface size",
    interfaceSizeAccessibility: "Interface font size",
    codeFont: "Code font",
    codeFontHint: "Used in code, diffs, and the terminal output. Leave empty for the system default",
    codeFontAccessibility: "Code font family",
    codeSize: "Code size",
    codeSizeAccessibility: "Code font size",
  },
  syntax: {
    title: "Syntax",
    highlightTheme: "Highlight theme",
    highlightThemeHint: "Colors for code, independent of the app theme",
    highlightThemeAccessibility: "Highlight theme: {{value}}",
    previewAccessibility: "Live preview of the syntax theme and code font",
  },
},
shortcuts: {
  unavailableOnMobile: "Keyboard shortcuts are only available on desktop",
  capturePrompt: "Press shortcut...",
  actions: {
    done: "Done",
    cancel: "Cancel",
    rebind: "Rebind",
    reset: "Reset",
    resetAll: "Reset all",
  },
  sections: {
    navigation: "Navigation",
    tabsPanes: "Tabs & Panes",
    projects: "Projects",
    panels: "Panels",
    agentInput: "Agent Input",
  },
  help: {
    openProject: "Open project",
    newWorktree: "New worktree",
    archiveWorktree: "Archive worktree",
    newTab: "New tab",
    closeCurrentTab: "Close current tab",
    jumpToWorkspace: "Jump to workspace",
    jumpToTab: "Jump to tab",
    previousWorkspace: "Previous workspace",
    nextWorkspace: "Next workspace",
    previousTab: "Previous tab",
    nextTab: "Next tab",
    splitPaneRight: "Split pane right",
    splitPaneDown: "Split pane down",
    focusPaneLeft: "Focus pane left",
    focusPaneRight: "Focus pane right",
    focusPaneUp: "Focus pane up",
    focusPaneDown: "Focus pane down",
    moveTabLeft: "Move tab left",
    moveTabRight: "Move tab right",
    moveTabUp: "Move tab up",
    moveTabDown: "Move tab down",
    closePane: "Close pane",
    newTerminal: "New terminal",
    toggleCommandCenter: "Toggle command center",
    showKeyboardShortcuts: "Show keyboard shortcuts",
    toggleLeftSidebar: "Toggle left sidebar",
    toggleRightSidebar: "Toggle right sidebar",
    toggleBothSidebars: "Toggle both sidebars",
    toggleSettings: "Toggle settings",
    toggleFocusMode: "Toggle focus mode",
    cycleTheme: "Cycle theme",
    focusMessageInput: "Focus message input",
    toggleVoiceMode: "Toggle voice mode",
    startStopDictation: "Start/stop dictation",
    interruptAgent: "Interrupt agent",
    sendMessage: "Send message",
    queueMessage: "Queue message",
    muteUnmuteVoiceMode: "Mute/unmute voice mode",
  },
},
integrations: {
  title: "Integrations",
  docs: {
    cli: "CLI docs",
    skills: "Skills docs",
    openCli: "Open CLI documentation",
    openSkills: "Open skills documentation",
  },
  commandLine: {
    title: "Command line",
    description: "Control and script agents from your terminal",
  },
  skills: {
    title: "Orchestration skills",
    description: "Teach your agents to orchestrate through the CLI",
    updateAvailable: "Update available",
    updateTitle: "Update Paseo skills?",
    updateFallback: "Sync bundled skills to your machine.",
    uninstallTitle: "Uninstall Paseo skills?",
    uninstallMessage: "Removes all Paseo orchestration skills from ~/.agents, ~/.claude, ~/.codex.",
  },
  actions: {
    install: "Install",
    installing: "Installing...",
    installed: "Installed",
    update: "Update",
    working: "Working...",
    uninstall: "Uninstall",
  },
  operations: {
    add: "Add skill",
    update: "Update skill",
    delete: "Delete skill",
  },
},
permissions: {
  title: "Permissions",
  notifications: "Notifications",
  microphone: "Microphone",
  refresh: "Refresh",
  refreshing: "Refreshing...",
  refreshAccessibility: "Refresh desktop permissions",
  test: "Test",
  actions: {
    granted: "Granted",
    request: "Request",
    requesting: "Requesting...",
    busySuffix: "{{label}}...",
  },
},
```

- [ ] **Step 4: Add Simplified Chinese resource groups**

Add matching keys in `packages/app/src/i18n/resources/zh-CN.ts`, preserving product glossary terms like Agent, CLI, Provider, Host, Mode, Daemon, and Model where existing docs keep them in English.

- [ ] **Step 5: Verify resources pass**

Run:

```bash
node node_modules/vitest/vitest.mjs run packages/app/src/i18n/resources.test.ts --bail=1
node_modules/oxfmt/bin/oxfmt packages/app/src/i18n/resources/en.ts packages/app/src/i18n/resources/zh-CN.ts packages/app/src/i18n/resources.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/app/src/i18n/resources/en.ts packages/app/src/i18n/resources/zh-CN.ts packages/app/src/i18n/resources.test.ts
git commit -m "feat: add settings expansion translations"
```

### Task 2: Translate Main Settings Diagnostics and About Chrome

**Files:**

- Modify: `packages/app/src/screens/settings-screen.tsx`

- [ ] **Step 1: Inject translation into Diagnostics/About helpers**

Use `useTranslation()` inside `DiagnosticsSection`, `AboutSection`, `ConnectedHostsSection`, `HostVersionRow`, and `DesktopAppUpdateRow`. Convert `getUpdateButtonLabel()` to accept a `t` function and version label.

- [ ] **Step 2: Translate local UI copy**

Replace these strings with resource keys:

- Diagnostics: `Diagnostics`, `Test audio`, `Playing...`, `Play test`, and the `Playback failed: {{message}}` wrapper.
- About: `About`, `App version`, `This device`, `Connected hosts`, `Offline`, `Version differs from this device`.
- Release/update: `Stable`, `Beta`, `Release channel`, release hint, `App updates`, `Ready to install: {{version}}`, update confirmation text, `Check`, `Checking...`, `Update`, `Update to {{version}}`, `Installing...`, alert title/message.

Keep `statusText`, `errorMessage`, version strings, host labels, and runtime error details raw.

- [ ] **Step 3: Verify**

Run:

```bash
node node_modules/@typescript/native-preview/bin/tsgo.js --noEmit -p packages/app/tsconfig.json
node_modules/oxlint/bin/oxlint packages/app/src/screens/settings-screen.tsx
node_modules/oxfmt/bin/oxfmt packages/app/src/screens/settings-screen.tsx
```

- [ ] **Step 4: Commit**

```bash
git add packages/app/src/screens/settings-screen.tsx
git commit -m "feat: translate settings diagnostics about chrome"
```

### Task 3: Translate Appearance Settings Chrome

**Files:**

- Modify: `packages/app/src/screens/settings/appearance/appearance-section.tsx`
- Modify: `packages/app/src/screens/settings/appearance/appearance-preview.tsx`

- [ ] **Step 1: Translate Appearance section**

Use `useTranslation()` and replace Appearance-owned strings from Task 1 resources. Convert theme labels to a small helper keyed by `AppSettings["theme"]`. Preserve syntax theme option labels from `SYNTAX_THEME_OPTIONS`.

- [ ] **Step 2: Translate Appearance preview accessibility label**

Use `useTranslation()` in `AppearancePreview` and replace the preview accessibility label.

- [ ] **Step 3: Verify**

Run:

```bash
node node_modules/@typescript/native-preview/bin/tsgo.js --noEmit -p packages/app/tsconfig.json
node_modules/oxlint/bin/oxlint packages/app/src/screens/settings/appearance/appearance-section.tsx packages/app/src/screens/settings/appearance/appearance-preview.tsx
node_modules/oxfmt/bin/oxfmt packages/app/src/screens/settings/appearance/appearance-section.tsx packages/app/src/screens/settings/appearance/appearance-preview.tsx
```

- [ ] **Step 4: Commit**

```bash
git add packages/app/src/screens/settings/appearance/appearance-section.tsx packages/app/src/screens/settings/appearance/appearance-preview.tsx
git commit -m "feat: translate appearance settings chrome"
```

### Task 4: Translate Keyboard Shortcuts Settings Chrome

**Files:**

- Modify: `packages/app/src/keyboard/keyboard-shortcuts.ts`
- Modify: `packages/app/src/screens/settings/keyboard-shortcuts-section.tsx`

- [ ] **Step 1: Add stable label keys to shortcut help metadata**

Add `titleKey` to `KeyboardShortcutHelpSection` and `labelKey` to `KeyboardShortcutHelpRow`. Map section ids and help ids to `settings.shortcuts.*` resource keys, keeping existing English `title` and `label` as fallback text for non-React callers.

- [ ] **Step 2: Translate shortcut Settings component**

Use `useTranslation()` in `KeyboardShortcutsSection`, `ShortcutSequence`, and `ShortcutRow`. Translate local actions and render `t(row.labelKey)` and `t(section.titleKey)`.

- [ ] **Step 3: Verify**

Run:

```bash
node node_modules/@typescript/native-preview/bin/tsgo.js --noEmit -p packages/app/tsconfig.json
node_modules/oxlint/bin/oxlint packages/app/src/keyboard/keyboard-shortcuts.ts packages/app/src/screens/settings/keyboard-shortcuts-section.tsx
node_modules/oxfmt/bin/oxfmt packages/app/src/keyboard/keyboard-shortcuts.ts packages/app/src/screens/settings/keyboard-shortcuts-section.tsx
```

- [ ] **Step 4: Commit**

```bash
git add packages/app/src/keyboard/keyboard-shortcuts.ts packages/app/src/screens/settings/keyboard-shortcuts-section.tsx
git commit -m "feat: translate shortcut settings chrome"
```

### Task 5: Translate Integrations and Desktop Permissions Chrome

**Files:**

- Modify: `packages/app/src/desktop/components/integrations-section.tsx`
- Modify: `packages/app/src/desktop/components/desktop-permissions-section.tsx`
- Modify: `packages/app/src/desktop/components/desktop-permission-row.tsx`

- [ ] **Step 1: Translate Integrations**

Use `useTranslation()` in `IntegrationsSection` and `SkillsActions`. Replace local chrome, docs labels/accessibility labels, install/update/uninstall labels, confirmation text, and operation-kind labels. Preserve operation `name` values and docs URLs.

- [ ] **Step 2: Translate Desktop Permissions**

Use `useTranslation()` in `DesktopPermissionsSection`. Pass translated `labels` into `DesktopPermissionRow`, including `granted`, `request`, `requesting`, and `busySuffix`.

- [ ] **Step 3: Verify**

Run:

```bash
node node_modules/@typescript/native-preview/bin/tsgo.js --noEmit -p packages/app/tsconfig.json
node_modules/oxlint/bin/oxlint packages/app/src/desktop/components/integrations-section.tsx packages/app/src/desktop/components/desktop-permissions-section.tsx packages/app/src/desktop/components/desktop-permission-row.tsx
node_modules/oxfmt/bin/oxfmt packages/app/src/desktop/components/integrations-section.tsx packages/app/src/desktop/components/desktop-permissions-section.tsx packages/app/src/desktop/components/desktop-permission-row.tsx
```

- [ ] **Step 4: Commit**

```bash
git add packages/app/src/desktop/components/integrations-section.tsx packages/app/src/desktop/components/desktop-permissions-section.tsx packages/app/src/desktop/components/desktop-permission-row.tsx
git commit -m "feat: translate desktop settings chrome"
```

### Task 6: Update Docs, Verify, Push, and Update PR

**Files:**

- Modify: `docs/i18n.md`

- [ ] **Step 1: Add Batch 3A progress note**

Append to the Progress section:

```md
- Batch 3A migrated Settings Diagnostics/About, Appearance, Shortcuts, Integrations, and Desktop Permissions chrome. Host settings and Project settings remain for Batch 3B; raw runtime status/error details remain untranslated.
```

- [ ] **Step 2: Run final verification**

Run:

```bash
node node_modules/vitest/vitest.mjs run packages/app/src/i18n/resources.test.ts --bail=1
node node_modules/vitest/vitest.mjs run packages/app/src/i18n/locales.test.ts --bail=1
node node_modules/@typescript/native-preview/bin/tsgo.js --noEmit -p packages/app/tsconfig.json
node_modules/oxlint/bin/oxlint
node_modules/oxfmt/bin/oxfmt docs/i18n.md packages/app/src/i18n/resources/en.ts packages/app/src/i18n/resources/zh-CN.ts packages/app/src/i18n/resources.test.ts packages/app/src/screens/settings-screen.tsx packages/app/src/screens/settings/appearance/appearance-section.tsx packages/app/src/screens/settings/appearance/appearance-preview.tsx packages/app/src/keyboard/keyboard-shortcuts.ts packages/app/src/screens/settings/keyboard-shortcuts-section.tsx packages/app/src/desktop/components/integrations-section.tsx packages/app/src/desktop/components/desktop-permissions-section.tsx packages/app/src/desktop/components/desktop-permission-row.tsx
PATH="$PWD/node_modules/.bin:$PATH" node node_modules/playwright/cli.js test packages/app/e2e/settings-i18n.spec.ts --config packages/app/playwright.config.ts --project='Desktop Chrome'
```

If Playwright leaves temporary `wrangler dev` or `expo start --web` processes, stop only those test processes.

- [ ] **Step 3: Commit docs**

```bash
git add docs/i18n.md
git commit -m "docs: update i18n batch 3a progress"
```

- [ ] **Step 4: Push and update PR**

```bash
git push fork feat/client-i18n
```

Update PR #1282 with the Batch 3A summary and verification commands.

---

## Self-Review

- Spec coverage: Implements Batch 3 settings expansion for main Settings, Appearance, Shortcuts, Integrations, and Desktop Permissions. Host settings and Project settings are intentionally deferred to Batch 3B.
- Boundary check: Raw runtime status/error details, operation names, host labels, version strings, provider/model names, docs URLs, file paths, and syntax theme option labels remain untranslated.
- Verification: Each task includes targeted typecheck/lint/format commands; final verification includes resource/locales tests, app typecheck, full oxlint, formatter, and the existing Settings i18n Playwright spec.

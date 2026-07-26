# Intrusive Desktop Attention Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make desktop attention hard to miss via configurable OS bubble sound, optional intrusive focus+navigate, in-app center-top banner, and an obvious Project|Status sidebar control.

**Architecture:** Keep daemon `computeNotificationPlan` / `shouldNotify` unchanged. After the client receives `shouldNotify`, a pure interrupt planner reads AppSettings + visibility/focus and returns `{ suppress, showOsBubble, showBanner, intrusiveFocusAndNavigate, playSound, soundPreset }`. Handlers execute those actions: Electron notifications (sound-aware `silent`), optional window focus IPC, in-app sound, attention banner host, and existing notification routes.

**Tech Stack:** TypeScript, React Native / Expo app, Electron desktop, Zustand/React Query settings, Vitest unit tests.

## Global Constraints

- Defaults: intrusive **off**, OS bubble **on**, sound **on**, one ideal preset.
- Agents and terminals share the same interrupt matrix.
- No daemon protocol changes; no mobile push changes; no Needs Attention strip; no notification inbox; no custom uploaded sounds.
- Prefer OS-native sound for bubbles; in-app sound engine for banner/intrusive.
- Always run targeted tests + `npm run typecheck` / lint / format for touched packages; never full suite locally.
- Protocol stays backward compatible (n/a if no protocol changes).

---

### Task 1: AppSettings attention fields + interrupt planner

**Files:**

- Modify: `packages/app/src/hooks/use-settings/storage.ts`
- Create: `packages/app/src/utils/attention-interrupt-plan.ts`
- Create: `packages/app/src/utils/attention-interrupt-plan.test.ts`
- Modify existing settings tests if present under `packages/app/src/hooks/use-settings/`

**Interfaces:**

- Produces:
  - `AttentionSoundPreset = "soft" | "ping" | "classic"`
  - `AppSettings.attentionIntrusiveMode: boolean` default `false`
  - `AppSettings.attentionOsBubbleEnabled: boolean` default `true`
  - `AppSettings.attentionSoundEnabled: boolean` default `true`
  - `AppSettings.attentionSoundPreset: AttentionSoundPreset` default `"soft"`
  - `planAttentionInterrupt(input): AttentionInterruptPlan`

- [ ] **Step 1: Extend AppSettings + normalize/pick**
- [ ] **Step 2: Implement pure `planAttentionInterrupt` matching the design matrix**
- [ ] **Step 3: Unit tests for planner + settings defaults**
- [ ] **Step 4: Commit**

### Task 2: Desktop notification sound + focus window IPC

**Files:**

- Modify: `packages/desktop/src/features/notifications.ts`
- Modify: `packages/desktop/src/preload.ts`
- Modify: `packages/app/src/desktop/host.ts`
- Modify: `packages/app/src/utils/os-notifications.ts`
- Modify: `packages/app/src/utils/os-notifications.test.ts`
- Modify: `packages/desktop/src/window/window-manager.ts` (or notifications) for `paseo:window:focus`

**Interfaces:**

- `sendNotification({ title, body?, data?, silent?: boolean })`
- `window.getCurrentWindow().focus?.(): Promise<void>` or `notification.focusWindow()`

- [ ] **Step 1: Stop hard-coding `silent: true`; use payload.silent ?? true for safety, app passes `silent: !soundEnabled`**
- [ ] **Step 2: Add focus-current-window IPC for intrusive path without bubble**
- [ ] **Step 3: Update app bridges + tests**
- [ ] **Step 4: Commit**

### Task 3: In-app attention sound + banner host

**Files:**

- Create: `packages/app/src/utils/attention-sound.ts` (Web Audio short tones per preset; no binary assets required)
- Create: `packages/app/src/stores/attention-banner-store.ts`
- Create: `packages/app/src/components/attention-banner-host.tsx`
- Modify: `packages/app/src/app/_layout.tsx` to mount host

**Interfaces:**

- `playAttentionSound(preset: AttentionSoundPreset): void`
- `showAttentionBanner({ title, body, data, extraCount? })` / dismiss / click callback via store

- [ ] **Step 1: Sound helper with soft/ping/classic oscillators**
- [ ] **Step 2: Banner store (replace latest + optional +N)**
- [ ] **Step 3: Center-top banner UI with auto-dismiss ~5s, click navigates**
- [ ] **Step 4: Commit**

### Task 4: Wire agent + terminal attention delivery

**Files:**

- Modify: `packages/app/src/contexts/session-context.tsx` notify paths
- Possibly extract helper: `packages/app/src/utils/deliver-attention-interrupt.ts`

**Flow:** on `shouldNotify` → load settings from query cache / getState → `planAttentionInterrupt` → execute actions (bubble/sound/focus+navigate/banner). Keep error skip for agent errors.

- [ ] **Step 1: Shared deliver helper**
- [ ] **Step 2: Agent path**
- [ ] **Step 3: Terminal path**
- [ ] **Step 4: Commit**

### Task 5: Settings UI (Permissions section)

**Files:**

- Modify: `packages/app/src/desktop/components/desktop-permissions-section.tsx`
- Modify: `packages/app/src/i18n/resources/en.ts` (+ other locales if required by tests)
- Modify: `packages/app/src/desktop/permissions/use-desktop-permissions.ts` test notification to respect sound/bubble

- [ ] **Step 1: Toggles for intrusive / bubble / sound + preset picker**
- [ ] **Step 2: i18n strings**
- [ ] **Step 3: Commit**

### Task 6: Project | Status sidebar control

**Files:**

- Modify: `packages/app/src/components/left-sidebar.tsx` and/or `sidebar-workspace-list.tsx`
- Possibly create: `packages/app/src/components/sidebar/sidebar-group-mode-control.tsx`
- Keep gear menu Group by as secondary

- [ ] **Step 1: Visible segmented Project|Status control bound to `useSidebarViewStore`**
- [ ] **Step 2: Place near list header / chrome (easy to find)**
- [ ] **Step 3: Commit**

### Task 7: Verify

- [ ] Targeted vitest for new unit tests
- [ ] `npm run typecheck` (or workspace-scoped if sufficient after hooks)
- [ ] `npm run lint` / format for touched files
- [ ] Final commit if needed

## Spec coverage checklist

| Spec item                               | Task                 |
| --------------------------------------- | -------------------- |
| Sound defaults + presets                | 1, 3, 5              |
| Fix silent OS notifications             | 2                    |
| Intrusive focus + navigate              | 2, 4                 |
| In-app banner when focused wrong target | 3, 4                 |
| Settings toggles + defaults             | 1, 5                 |
| Terminal same matrix                    | 4                    |
| Project\|Status discoverability         | 6                    |
| No daemon/mobile/strip/inbox            | respected throughout |

# Intrusive desktop attention — design

**Date:** 2026-07-26  
**Status:** Approved for implementation planning  
**Surface:** Desktop (Electron) primary; client settings shared where they apply to web desktop host

## Problem

Users run Paseo as their coding surface on a large primary display, while a laptop screen often holds secondary apps (chat, video). Today:

1. Desktop OS notifications are hard-coded **silent** (`packages/desktop/src/features/notifications.ts` sets `silent: true`).
2. macOS Notification Center bubbles frequently appear on the **laptop** display, not the monitor the user is looking at.
3. When the user is already inside Paseo but on another workspace/agent, there is no strong **in-app** interrupt (only OS bubble if not suppressed).
4. Sidebar **Group by → Status** already lists workspaces that need input / failed / ready to review, but the control is buried under a display-preferences gear — easy to miss.

Daemon presence policy and mobile Expo push are **not** the broken path for this multi-monitor desktop failure mode. The failure is delivery UX on the desktop client.

## Goals

- Make attention hard to ignore when the user is on another app or Space (optional **intrusive** mode).
- Make attention hard to ignore when the user is already in Paseo on the wrong agent/terminal (**in-app banner** + sound).
- Restore **notification sound** with a small preset set and mute control.
- Keep OS bubble as a configurable channel (default on for conservative upgrade).
- Improve **discoverability** of existing Status sidebar grouping.
- Treat **agent** and **terminal** attention the same for interrupt rules.

## Non-goals

- Mobile push policy / Expo token path changes.
- Daemon redesign of `computeNotificationPlan` / multi-client presence protocol.
- A separate “Needs Attention” sidebar strip or Notifications inbox menu.
- Custom user-uploaded notification sound files.
- Forcing the Paseo window onto a specific display (OS window placement is enough: show/focus the existing window).
- Changing when attention is **suppressed** while the user is focused on the same agent/terminal (existing policy stays).

## Current architecture (as-is)

```
Daemon
  attention event → computeNotificationPlan(presence, focusTarget, pushEligible)
    → shouldNotify on at most one present client
    → or push when no present client

App (session-context)
  on shouldNotify → notifyAgentAttention / terminal handler
    → suppress if actively visible AND focused on that agent
    → else sendOsNotification(...)

Desktop
  paseo:notification:send → Electron Notification { silent: true }
  click → show/restore/focus window + notification-click event → route
```

Relevant pieces:

| Area                   | Location                                                                           |
| ---------------------- | ---------------------------------------------------------------------------------- |
| Presence / plan        | `packages/server/src/server/agent-attention-policy.ts`                             |
| Client notify          | `packages/app/src/contexts/session-context.tsx`                                    |
| OS send                | `packages/app/src/utils/os-notifications.ts`                                       |
| Electron notifications | `packages/desktop/src/features/notifications.ts`                                   |
| Route on click         | `packages/app/src/utils/notification-routing.ts`, `_layout` PushNotificationRouter |
| Focused visibility     | `packages/app/src/utils/app-visibility.ts` (`getIsAppActivelyVisible`)             |
| Sidebar group mode     | `packages/app/src/stores/sidebar-view-store.ts` (`project` \| `status`)            |
| Status groups          | `packages/app/src/hooks/sidebar-status-view-model.ts`                              |
| Group-by UI            | `packages/app/src/components/sidebar/sidebar-display-preferences-menu.tsx` (gear)  |
| Client settings        | `packages/app/src/hooks/use-settings` (`AppSettings` / AsyncStorage)               |
| Desktop settings       | daemon management / release channel only — not the right home for UX toggles       |
| Deep-link style focus  | `packages/desktop/src/main.ts` `focusExistingWindowOnAgent`                        |

## Product decisions (locked)

### Defaults (desktop)

| Setting                    | Default                                                 |
| -------------------------- | ------------------------------------------------------- |
| Intrusive mode             | **Off**                                                 |
| System notification bubble | **On**                                                  |
| Sound                      | **On**                                                  |
| Sound preset               | One ideal built-in default; user can pick among presets |

### Behavior matrix

Shared by **agent** attention (`finished` / `permission`; errors remain non-OS-notify as today) and **terminal** attention.

| Client state                                                                                  | Intrusive off                                                                                                   | Intrusive on                                                                                       |
| --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| **Unfocused** (not actively visible: other app, other Space, window blurred, document hidden) | If bubble on → OS bubble; if sound on → play with bubble (and/or standalone if bubble off — see Delivery rules) | Focus/show Paseo window + navigate to target + sound if on; OS bubble only if bubble still enabled |
| **Focused in Paseo, wrong agent/terminal**                                                    | Center-top in-app banner + sound if on; OS bubble only if bubble enabled                                        | Same (no extra focus-steal)                                                                        |
| **Focused on that agent/terminal**                                                            | Suppress all interrupt channels (existing)                                                                      | Same                                                                                               |

“Focused on target” continues to mean: `getIsAppActivelyVisible` and session focus matches the attention agent (or terminal focus target for terminal events). Daemon `shouldNotify` remains the gate that this client is the chosen present recipient; the client then chooses **how** to interrupt.

### Delivery rules

1. **Daemon contract unchanged.** Still only deliver `shouldNotify: true` to the presence-selected client (or push when none). No new protocol fields required for v1.
2. **Client-owned interrupt mode.** After `shouldNotify`, the desktop/web client reads local settings and visibility to choose bubble / banner / autofocus.
3. **Sound** is orthogonal: when sound is on, play for any non-suppressed interrupt that is actually delivered (bubble, banner, or intrusive focus). When sound is off, all paths are silent.
4. **Bubble off + intrusive off:** still allow **banner** when app is focused on the wrong target; when unfocused, only sound if we choose a non-bubble channel — **v1 rule:** if both bubble and intrusive are off and app is unfocused, play sound only (no focus steal, no bubble). User can enable bubble or intrusive if that is too quiet.
5. **Bubble off + intrusive on:** focus + navigate + sound; no OS bubble.
6. **Multiple rapid events:** banner **replaces** with the latest item; if more than one is outstanding while the banner is visible, show a simple “+N” affordance. Do not stack multiple banners.
7. **Banner lifetime:** auto-dismiss after a short timeout (≈4–6s) **or** on click / explicit dismiss. Click navigates via the same routing as OS notification click.
8. **Intrusive navigate:** use existing route builders (`buildNotificationRoute` / open workspace agent or terminal tab). Prefer focusing the **window that owns the notification sender** (`BrowserWindow.fromWebContents`), matching current notification-click behavior; if that window is gone, fall back to focused/visible/first window (same family as deep-link focus).
9. **Errors:** keep current product rule — agent `error` attention is not push-eligible and the app already skips OS notify for errors. Do not expand error into intrusive/banner unless product revisits that later.
10. **Web browser (non-Electron):** no true force-focus of the OS window. Apply banner + Web Notification (if bubble on) + sound; intrusive mode degrades to banner-when-visible and Web Notification-when-hidden without guaranteeing OS focus.

### Sidebar discoverability

- Add a clear **Project | Status** control near the workspace list (segmented control or equivalent), bound to `useSidebarViewStore.groupMode`.
- Keep the gear menu for host filter and workspace title source; it may still list Group by for redundancy, but **must not** be the only path.
- Do **not** add a parallel “Needs Attention” strip; Status mode already groups Needs input / Failed / Ready to review / Working / Done.

### Settings UI

- Place controls under **Settings → Permissions** (existing notification permission + test notification) as a **Notifications / Attention** subsection on desktop, **or** a sibling desktop-only block on that section so permission status and behavior settings stay together.
- Controls:
  - Intrusive mode (toggle + short description: brings Paseo forward and opens the workspace that needs you)
  - System notification bubble (toggle)
  - Play sound (toggle)
  - Sound preset (picker; disabled when sound off)
- Test notification path should respect sound/bubble settings (and document that intrusive is not triggered by the test button unless we explicitly simulate an attention event later).

## Target architecture (to-be)

```
shouldNotify event
  → client interrupt planner (pure function, unit-tested)
       inputs: settings, isActivelyVisible, focusedAgentId/terminalId, payload target
       outputs: { suppress, showOsBubble, showBanner, intrusiveFocusAndNavigate, playSound, preset }

  → if playSound: play preset (in-app path and/or OS path)
  → if showOsBubble: sendOsNotification (Electron silent flag = !playSound)
  → if intrusiveFocusAndNavigate: desktop focus window + router navigate
  → if showBanner: attention banner host (center-top)
```

### New / changed modules (indicative)

| Concern             | Approach                                                                                                               |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Settings fields     | Extend `AppSettings` in `hooks/use-settings/storage` with optional fields + defaults (backward compatible JSON)        |
| Interrupt planner   | Pure helper e.g. `packages/app/src/utils/attention-interrupt-plan.ts`                                                  |
| Sound               | Small desktop/web helper: play bundled preset; Electron OS bubble uses `silent: !soundEnabled`                         |
| Banner host         | App-shell overlay near top center (dedicated component; do not overload generic toast for click-to-navigate attention) |
| Intrusive focus IPC | Reuse show/focus pattern from notifications; may add `paseo:window:focus` if focus is needed without sending a bubble  |
| Session handlers    | Agent + terminal notify paths call planner then execute actions                                                        |
| Sidebar             | Project \| Status control in left sidebar chrome                                                                       |

### Multi-window

- Intrusive focus and bubble click: prefer the **sender** window; else focused → visible → first.
- Navigation after focus is per-window webContents (same as today). Do not broadcast navigate to all windows in v1.

## UX copy notes

- Prefer plain language over jargon: “Bring Paseo to the front when something needs you” rather than “intrusive notification mode” in the primary label if space allows; “Intrusive mode” can be the short label with the sentence as description.
- Status control labels stay **Project** / **Status** (existing Group by labels).
- Banner body reuses attention title/body already built for OS notifications.

## Testing strategy

- **Unit:** interrupt planner matrix (visibility × focus match × settings × agent vs terminal).
- **Unit:** settings normalize/migrate defaults for new fields.
- **Unit/desktop:** notification send maps sound setting → `silent` flag (fix regression on hard-coded silent).
- **Component/light e2e where feasible:** Project|Status control switches `groupMode`; banner click routes; existing notification routing tests remain green.
- **Manual (desktop):** multi-monitor — bubble display vs focus-steal; sound on/off; intrusive on with bubble off; focused-wrong-agent banner only.

## Risks and mitigations

| Risk                                            | Mitigation                                                                           |
| ----------------------------------------------- | ------------------------------------------------------------------------------------ |
| Focus-steal feels aggressive                    | Default intrusive **off**; clear setting description                                 |
| macOS still places bubbles on secondary display | Intrusive mode + in-app banner address the real workflow; bubble remains optional    |
| Generic toast misuse                            | Dedicated attention banner with navigate payload                                     |
| Settings sprawl                                 | Keep under Permissions/Notifications; client AppSettings not desktop daemon settings |
| Silent notifications forgotten                  | Explicit test coverage on Electron `silent` derived from sound setting               |

## Success criteria

1. With defaults (intrusive off, bubble on, sound on), OS notifications **audibly** play the default preset.
2. With intrusive on and bubble off, an unfocused desktop client brings Paseo forward and opens the correct workspace/agent or terminal.
3. When focused on another agent, user sees a center-top banner with sound and can click to open the target.
4. Focused on the notifying agent/terminal still produces **no** bubble/banner/sound.
5. User can find **Status** grouping without opening the gear menu.
6. Terminal finished attention follows the same interrupt matrix as agents.

## Open implementation details (not product-open)

These are left to the implementation plan, not further product interview:

- Exact auto-dismiss milliseconds and animation.
- Exact preset list filenames and naming (“Soft”, “Ping”, …).
- Whether sound for OS bubble is OS-native only or also double-plays in-app (prefer **OS-native for bubble, in-app engine for banner/intrusive** to avoid double audio).
- Whether Permissions section is renamed vs a nested subsection.

## Revision history

- 2026-07-26 — Initial design from user workflow interview + codebase due diligence. Approach: client-side attention layer; discoverability of Status mode instead of a new Needs Attention strip.

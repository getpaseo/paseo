# Full Client UI I18n Batch 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate client-owned Composer and agent workflow UI copy to English/Simplified Chinese i18n resources.

**Architecture:** Keep `i18next`/`react-i18next` as the single app translation layer. Add grouped resource keys for `composer`, `agentControls`, `agentStream`, `agentPanel`, and `panels.draft`, then migrate each local UI copy cluster at the component that owns it. Provider names, model names, provider-defined mode labels, provider feature labels/tooltips, agent output, daemon output, and raw protocol/server errors remain untranslated.

**Tech Stack:** Expo React Native, i18next, react-i18next, Vitest, oxlint, oxfmt, TypeScript native preview (`tsgo`).

---

## File Structure

- Modify: `packages/app/src/i18n/resources/en.ts`
  - Add Batch 2 resource groups for Composer input, attachment menu, GitHub attachment picker, agent controls, permission wrapper UI, agent panel wrapper states, and draft panel descriptors.
- Modify: `packages/app/src/i18n/resources/zh-CN.ts`
  - Add matching Simplified Chinese resources while preserving glossary product terms such as Agent, Provider, Model, Host, and Mode where the glossary keeps them in English.
- Modify: `packages/app/src/i18n/resources.test.ts`
  - Add explicit assertions for representative Batch 2 keys, plus the existing parity check.
- Modify: `packages/app/src/composer/input/input.tsx`
  - Translate Composer input placeholder fallback, input accessibility label, attachment trigger label/tooltip, send button labels/tooltips, voice button labels/tooltips, focus hint suffix, and local voice-mode interruption toast.
- Modify: `packages/app/src/composer/index.tsx`
  - Translate desktop/mobile Composer placeholders, cancel/realtime voice button labels/tooltips, queued-message attachment labels, attachment menu labels, and GitHub picker shell copy.
- Modify: `packages/app/src/composer/agent-controls/utils.ts`
  - Replace hardcoded agent-control hint strings with key lookup by returning stable i18n key ids.
- Modify: `packages/app/src/composer/agent-controls/utils.test.ts`
  - Update the pure helper test to assert the hint keys.
- Modify: `packages/app/src/composer/agent-controls/index.tsx`
  - Translate Provider fallback, Provider/Thinking accessibility labels, model/thinking tooltip labels, mobile Features sheet title, mobile Features accessibility label, Thinking sheet title, and On/Off toggle state copy.
- Modify: `packages/app/src/composer/agent-controls/mode-control.tsx`
  - Translate Mode sheet title, search placeholder, and select-mode accessibility label. Do not translate provider-defined mode display labels.
- Modify: `packages/app/src/agent-stream/view.tsx`
  - Translate stream empty state, scroll-to-bottom accessibility label, permission wrapper fallback title, plan title, default Deny/Accept/Implement action labels, footer question, and Proposed plan title. Keep `request.title`, `request.name`, `request.description`, tool details, and the deny response payload `"Denied by user"` unchanged.
- Modify: `packages/app/src/panels/agent-panel.tsx`
  - Translate local agent-not-found/load-error titles, reconnecting toast/status copy, selected Host fallback, unavailable-host copy, connection/loading wrapper states, and archiving overlay copy. Keep `lastError`, `lookupState.message`, and `Agent not found: ${agentId}` diagnostic messages unchanged.
- Modify: `packages/app/src/panels/draft-panel-descriptor.ts`
  - Translate New Agent and Creating agent descriptor copy by accepting an injected translator from callers that render descriptors.
- Modify: `packages/app/src/panels/agent-panel-descriptor.test.tsx`
  - Update descriptor assertions if `buildDraftPanelDescriptor` signature changes.
- Modify: `docs/i18n.md`
  - Add a Batch 2 progress note under the staged migration order.

---

### Task 1: Add Batch 2 Translation Resources

**Files:**

- Modify: `packages/app/src/i18n/resources/en.ts`
- Modify: `packages/app/src/i18n/resources/zh-CN.ts`
- Modify: `packages/app/src/i18n/resources.test.ts`

- [ ] **Step 1: Add failing resource assertions**

Append this test after the existing Batch 1 explicit-key test in `packages/app/src/i18n/resources.test.ts`:

```ts
it("includes composer and agent workflow keys for the Batch 2 migration", () => {
  expect(en.composer.placeholders.desktop).toBe(
    "Message the agent, tag @files, or use /commands and /skills",
  );
  expect(en.composer.input.addAttachment).toBe("Add attachment");
  expect(en.composer.input.sendMessage).toBe("Send message");
  expect(en.composer.voice.startDictation).toBe("Start dictation");
  expect(en.composer.attachments.addIssueOrPr).toBe("Add issue or PR");
  expect(en.composer.github.title).toBe("Attach issue or PR");
  expect(en.agentControls.provider.fallback).toBe("Provider");
  expect(en.agentControls.hints.model).toBe("Change model");
  expect(en.agentControls.features.title).toBe("Features");
  expect(en.agentControls.mode.title).toBe("Mode");
  expect(en.agentStream.permission.required).toBe("Permission Required");
  expect(en.agentStream.permission.proposedPlan).toBe("Proposed plan");
  expect(en.agentPanel.unavailable.selectedHost).toBe("Selected host");
  expect(en.agentPanel.states.notFound).toBe("Agent not found");
  expect(en.panels.draft.newAgent).toBe("New Agent");
});
```

- [ ] **Step 2: Run resource test to verify it fails**

Run:

```bash
node node_modules/vitest/vitest.mjs run packages/app/src/i18n/resources.test.ts --bail=1
```

Expected: FAIL because the new Batch 2 key groups do not exist yet.

- [ ] **Step 3: Add English resource groups**

In `packages/app/src/i18n/resources/en.ts`, insert these groups after the existing `shell` block and before `settings`:

```ts
composer: {
  placeholders: {
    desktop: "Message the agent, tag @files, or use /commands and /skills",
    mobile: "Message, @files, /commands",
    fallback: "Message...",
  },
  input: {
    accessibilityLabel: "Message agent...",
    focusHint: "{{shortcut}} to focus",
    addAttachment: "Add attachment",
    interruptAgent: "Interrupt agent",
    queueMessage: "Queue message",
    sendAndInterrupt: "Send and interrupt",
    sendMessage: "Send message",
    queue: "Queue",
    send: "Send",
  },
  cancel: {
    cancelingAgent: "Canceling agent",
    stopAgent: "Stop agent",
    interrupt: "Interrupt",
  },
  voice: {
    enableVoiceMode: "Enable Voice mode",
    voiceMode: "Voice mode",
    unmuteVoiceMode: "Unmute Voice mode",
    muteVoiceMode: "Mute Voice mode",
    stopDictation: "Stop dictation",
    startDictation: "Start dictation",
    unmuteVoice: "Unmute voice",
    muteVoice: "Mute voice",
    dictation: "Dictation",
    interruptBeforeVoice: "Interrupt the agent before starting voice mode",
  },
  attachments: {
    addImage: "Add image",
    addIssueOrPr: "Add issue or PR",
    editQueuedMessage: "Edit queued message",
    sendQueuedMessageNow: "Send queued message now",
    openImage: "Open image attachment",
    removeImage: "Remove image attachment",
    openGithub: "Open {{kind}} #{{number}}",
    removeGithub: "Remove {{kind}} #{{number}}",
  },
  github: {
    searching: "Searching...",
    noResults: "No results found.",
    searchPlaceholder: "Search issues and PRs...",
    title: "Attach issue or PR",
  },
},
agentControls: {
  provider: {
    fallback: "Provider",
    select: "Select agent provider",
  },
  thinking: {
    title: "Thinking",
    unknown: "Unknown",
    select: "Select thinking option",
    selectWithValue: "Select thinking option ({{value}})",
  },
  features: {
    title: "Features",
    open: "Open agent features",
    on: "On",
    off: "Off",
  },
  mode: {
    title: "Mode",
    searchPlaceholder: "Search modes...",
    selectWithValue: "Select agent mode ({{value}})",
  },
  hints: {
    thinking: "Thinking mode",
    model: "Change model",
    mode: "Change permission mode",
  },
},
agentStream: {
  empty: "Start chatting with this agent...",
  scrollToBottom: "Scroll to bottom",
  permission: {
    plan: "Plan",
    required: "Permission Required",
    deny: "Deny",
    accept: "Accept",
    implement: "Implement",
    question: "How would you like to proceed?",
    proposedPlan: "Proposed plan",
  },
},
agentPanel: {
  states: {
    notFound: "Agent not found",
    failedToLoad: "Failed to load agent",
    reconnecting: "Reconnecting...",
    archivingTitle: "Archiving agent...",
    archivingSubtitle: "Please wait while we archive this agent.",
  },
  unavailable: {
    selectedHost: "Selected host",
    unknownHost:
      "Cannot open this agent because {{serverLabel}} is not configured on this device.",
    addHost:
      "Add the host in Settings or open an agent on a configured server to continue.",
    preparingSession: "Preparing {{serverLabel}} session...",
    connecting: "Connecting to {{serverLabel}}...",
    showSoon: "We will show this agent in a moment.",
    showWhenOnline: "We will show this agent once the host is online.",
    reconnectingTo: "Reconnecting to {{serverLabel}}...",
    showAgainWhenReachable:
      "We will show this agent again as soon as the host is reachable.",
  },
},
panels: {
  draft: {
    newAgent: "New Agent",
    creatingAgent: "Creating agent",
  },
},
```

- [ ] **Step 4: Add Simplified Chinese resource groups**

In `packages/app/src/i18n/resources/zh-CN.ts`, insert matching groups after the existing `shell` block and before `settings`:

```ts
composer: {
  placeholders: {
    desktop: "给 Agent 发消息，标记 @files，或使用 /commands 和 /skills",
    mobile: "发消息，@files，/commands",
    fallback: "输入消息...",
  },
  input: {
    accessibilityLabel: "给 Agent 发消息...",
    focusHint: "{{shortcut}} 聚焦",
    addAttachment: "添加附件",
    interruptAgent: "中断 Agent",
    queueMessage: "消息排队",
    sendAndInterrupt: "发送并中断",
    sendMessage: "发送消息",
    queue: "排队",
    send: "发送",
  },
  cancel: {
    cancelingAgent: "正在取消 Agent",
    stopAgent: "停止 Agent",
    interrupt: "中断",
  },
  voice: {
    enableVoiceMode: "启用语音模式",
    voiceMode: "语音模式",
    unmuteVoiceMode: "取消静音语音模式",
    muteVoiceMode: "静音语音模式",
    stopDictation: "停止听写",
    startDictation: "开始听写",
    unmuteVoice: "取消静音",
    muteVoice: "静音",
    dictation: "听写",
    interruptBeforeVoice: "启动语音模式前请先中断 Agent",
  },
  attachments: {
    addImage: "添加图片",
    addIssueOrPr: "添加 issue 或 PR",
    editQueuedMessage: "编辑排队消息",
    sendQueuedMessageNow: "立即发送排队消息",
    openImage: "打开图片附件",
    removeImage: "移除图片附件",
    openGithub: "打开 {{kind}} #{{number}}",
    removeGithub: "移除 {{kind}} #{{number}}",
  },
  github: {
    searching: "正在搜索...",
    noResults: "没有结果。",
    searchPlaceholder: "搜索 issues 和 PRs...",
    title: "附加 issue 或 PR",
  },
},
agentControls: {
  provider: {
    fallback: "Provider",
    select: "选择 Agent Provider",
  },
  thinking: {
    title: "Thinking",
    unknown: "未知",
    select: "选择 thinking 选项",
    selectWithValue: "选择 thinking 选项（{{value}}）",
  },
  features: {
    title: "Features",
    open: "打开 Agent features",
    on: "开启",
    off: "关闭",
  },
  mode: {
    title: "Mode",
    searchPlaceholder: "搜索 modes...",
    selectWithValue: "选择 Agent mode（{{value}}）",
  },
  hints: {
    thinking: "Thinking mode",
    model: "切换 Model",
    mode: "切换权限 Mode",
  },
},
agentStream: {
  empty: "开始和这个 Agent 对话...",
  scrollToBottom: "滚动到底部",
  permission: {
    plan: "Plan",
    required: "需要权限",
    deny: "拒绝",
    accept: "接受",
    implement: "实施",
    question: "你想如何继续？",
    proposedPlan: "建议计划",
  },
},
agentPanel: {
  states: {
    notFound: "未找到 Agent",
    failedToLoad: "加载 Agent 失败",
    reconnecting: "正在重连...",
    archivingTitle: "正在归档 Agent...",
    archivingSubtitle: "请稍候，我们正在归档这个 Agent。",
  },
  unavailable: {
    selectedHost: "选中的 Host",
    unknownHost: "无法打开此 Agent，因为此设备上未配置 {{serverLabel}}。",
    addHost: "请在设置中添加 Host，或打开已配置 server 上的 Agent 后继续。",
    preparingSession: "正在准备 {{serverLabel}} 会话...",
    connecting: "正在连接 {{serverLabel}}...",
    showSoon: "稍后将显示此 Agent。",
    showWhenOnline: "Host 在线后将显示此 Agent。",
    reconnectingTo: "正在重新连接 {{serverLabel}}...",
    showAgainWhenReachable: "Host 可访问后将再次显示此 Agent。",
  },
},
panels: {
  draft: {
    newAgent: "新建 Agent",
    creatingAgent: "正在创建 Agent",
  },
},
```

Preserve `issue`, `PR`, `Agent`, `Provider`, `Model`, `Host`, `Mode`, and `Features` where they are established product/provider terms.

- [ ] **Step 5: Run resource test**

Run:

```bash
node node_modules/vitest/vitest.mjs run packages/app/src/i18n/resources.test.ts --bail=1
```

Expected: PASS.

- [ ] **Step 6: Format and commit resources**

Run:

```bash
node_modules/oxfmt/bin/oxfmt packages/app/src/i18n/resources/en.ts packages/app/src/i18n/resources/zh-CN.ts packages/app/src/i18n/resources.test.ts
git add packages/app/src/i18n/resources/en.ts packages/app/src/i18n/resources/zh-CN.ts packages/app/src/i18n/resources.test.ts
git commit -m "feat: add composer agent workflow translations"
```

---

### Task 2: Translate Composer Input Controls

**Files:**

- Modify: `packages/app/src/composer/input/input.tsx`

- [ ] **Step 1: Import translation hook and type**

At the imports in `packages/app/src/composer/input/input.tsx`, add:

```ts
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
```

- [ ] **Step 2: Update label helper signatures**

Replace the submit, voice, and send tooltip helpers with translation-aware versions:

```ts
function resolveSubmitAccessibilityLabel(input: {
  submitButtonAccessibilityLabel: string | undefined;
  canPressLoadingButton: boolean;
  defaultActionQueues: boolean;
  isAgentRunning: boolean;
  t: TFunction;
}): string {
  if (input.submitButtonAccessibilityLabel) return input.submitButtonAccessibilityLabel;
  if (input.canPressLoadingButton) return input.t("composer.input.interruptAgent");
  if (input.defaultActionQueues) return input.t("composer.input.queueMessage");
  if (input.isAgentRunning) return input.t("composer.input.sendAndInterrupt");
  return input.t("composer.input.sendMessage");
}

function resolveVoiceAccessibilityLabel(input: {
  isRealtimeVoiceForCurrentAgent: boolean;
  isMuted: boolean;
  isDictating: boolean;
  t: TFunction;
}): string {
  if (input.isRealtimeVoiceForCurrentAgent) {
    return input.isMuted
      ? input.t("composer.voice.unmuteVoiceMode")
      : input.t("composer.voice.muteVoiceMode");
  }
  if (input.isDictating) return input.t("composer.voice.stopDictation");
  return input.t("composer.voice.startDictation");
}

function resolveVoiceTooltipText(input: {
  isRealtimeVoiceForCurrentAgent: boolean;
  isMuted: boolean;
  t: TFunction;
}): string {
  if (input.isRealtimeVoiceForCurrentAgent) {
    return input.isMuted
      ? input.t("composer.voice.unmuteVoice")
      : input.t("composer.voice.muteVoice");
  }
  return input.t("composer.voice.dictation");
}

function resolveSendTooltipLabel(input: {
  submitButtonAccessibilityLabel: string | undefined;
  defaultActionQueues: boolean;
  t: TFunction;
}): string {
  if (input.submitButtonAccessibilityLabel) return input.submitButtonAccessibilityLabel;
  return input.defaultActionQueues
    ? input.t("composer.input.queue")
    : input.t("composer.input.send");
}
```

- [ ] **Step 3: Add translated labels inside `MessageInput`**

Inside `MessageInput`, immediately after the destructured props from `resolveMessageInputProps(props)`, add:

```ts
const { t } = useTranslation();
```

Then change the fallback placeholder in `resolveMessageInputProps` from:

```ts
placeholder: props.placeholder ?? "Message...",
```

to:

```ts
placeholder: props.placeholder,
```

Update `ResolvedMessageInputProps.placeholder` from `string` to:

```ts
placeholder: string | undefined;
```

and make the rendered placeholder use:

```tsx
placeholder={placeholder ?? t("composer.placeholders.fallback")}
```

- [ ] **Step 4: Translate attachment trigger copy**

Pass `addAttachmentLabel` into `AttachmentDropdown`:

```tsx
<AttachmentDropdown
  isConnected={isConnected}
  disabled={disabled}
  attachButtonStyle={attachButtonStyle}
  renderAttachButtonIcon={renderAttachButtonIcon}
  attachmentMenuItems={attachmentMenuItems}
  addAttachmentLabel={t("composer.input.addAttachment")}
/>
```

Update `AttachmentDropdown` props:

```ts
addAttachmentLabel: string;
```

Use it in the trigger and tooltip:

```tsx
accessibilityLabel = { addAttachmentLabel };
```

```tsx
<Text style={styles.tooltipText}>{addAttachmentLabel}</Text>
```

- [ ] **Step 5: Translate computed input labels**

Pass `t` into helper calls:

```ts
const submitAccessibilityLabel = resolveSubmitAccessibilityLabel({
  submitButtonAccessibilityLabel,
  canPressLoadingButton,
  defaultActionQueues,
  isAgentRunning,
  t,
});

const voiceButtonAccessibilityLabel = resolveVoiceAccessibilityLabel({
  isRealtimeVoiceForCurrentAgent,
  isMuted: Boolean(voice?.isMuted),
  isDictating,
  t,
});

const voiceTooltipText = resolveVoiceTooltipText({
  isRealtimeVoiceForCurrentAgent,
  isMuted: Boolean(voice?.isMuted),
  t,
});
```

Inside `SendButtonTooltip`, update the `resolveSendTooltipLabel` call to include `t`, and pass `t` as a prop from the call site:

```tsx
<SendButtonTooltip
  ...
  t={t}
/>
```

- [ ] **Step 6: Translate input accessibility and focus hint**

Change:

```tsx
accessibilityLabel = "Message agent...";
```

to:

```tsx
accessibilityLabel={t("composer.input.accessibilityLabel")}
```

In `FocusHint`, add a `label` prop and render it:

```tsx
<FocusHint
  visible={isWeb && isPaneFocused && !isInputFocused && !value}
  focusInputKeys={focusInputKeys}
  label={t("composer.input.focusHint", {
    shortcut: focusInputKeys ? formatShortcut(focusInputKeys, getShortcutOs()) : "",
  })}
/>
```

Update `FocusHint` so it no longer builds English text internally. If `label.trim()` is empty, render nothing.

- [ ] **Step 7: Translate local voice interruption toast**

Find the realtime voice toggle implementation that currently calls:

```ts
toast.error("Interrupt the agent before starting voice mode");
```

Pass a translated message into that helper from `MessageInput`:

```ts
interruptBeforeVoiceMessage: t("composer.voice.interruptBeforeVoice"),
```

and make the helper call:

```ts
toast.error(input.interruptBeforeVoiceMessage);
```

- [ ] **Step 8: Run focused checks**

Run:

```bash
node node_modules/vitest/vitest.mjs run packages/app/src/i18n/resources.test.ts --bail=1
node node_modules/@typescript/native-preview/bin/tsgo.js --noEmit -p packages/app/tsconfig.json
node_modules/oxlint/bin/oxlint packages/app/src/composer/input/input.tsx
```

Expected: PASS.

- [ ] **Step 9: Format and commit Composer input migration**

Run:

```bash
node_modules/oxfmt/bin/oxfmt packages/app/src/composer/input/input.tsx
git add packages/app/src/composer/input/input.tsx
git commit -m "feat: translate composer input controls"
```

---

### Task 3: Translate Composer Shell, Queue, Attachments, and GitHub Picker

**Files:**

- Modify: `packages/app/src/composer/index.tsx`

- [ ] **Step 1: Import translation hook and type**

Add:

```ts
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
```

- [ ] **Step 2: Replace module-level placeholder constants**

Delete:

```ts
const DESKTOP_MESSAGE_PLACEHOLDER = "Message the agent, tag @files, or use /commands and /skills";
const MOBILE_MESSAGE_PLACEHOLDER = "Message, @files, /commands";
```

Update `resolveMessagePlaceholder` to accept `t`:

```ts
function resolveMessagePlaceholder(isDesktopWebBreakpoint: boolean, t: TFunction): string {
  return isDesktopWebBreakpoint
    ? t("composer.placeholders.desktop")
    : t("composer.placeholders.mobile");
}
```

Inside `Composer`, add:

```ts
const { t } = useTranslation();
```

and call:

```ts
const messagePlaceholder = resolveMessagePlaceholder(isDesktopWebBreakpoint, t);
```

- [ ] **Step 3: Translate cancel and voice buttons**

Pass `t` into `ComposerCancelButtonSlot` and `ComposerVoiceModeButton` props. In `ComposerCancelButton`, replace:

```ts
const accessibilityLabel = isCancellingAgent ? "Canceling agent" : "Stop agent";
```

with:

```ts
const accessibilityLabel = isCancellingAgent
  ? t("composer.cancel.cancelingAgent")
  : t("composer.cancel.stopAgent");
```

Replace the cancel tooltip:

```tsx
<Text style={styles.tooltipText}>{t("composer.cancel.interrupt")}</Text>
```

In `ComposerVoiceModeButton`, replace:

```tsx
accessibilityLabel = "Enable Voice mode";
```

with:

```tsx
accessibilityLabel={t("composer.voice.enableVoiceMode")}
```

and replace the tooltip text with:

```tsx
<Text style={styles.tooltipText}>{t("composer.voice.voiceMode")}</Text>
```

- [ ] **Step 4: Translate attachment menu labels**

Change `attachmentMenuItems` labels to:

```ts
label: t("composer.attachments.addImage"),
```

and:

```ts
label: t("composer.attachments.addIssueOrPr"),
```

Add `t` to the `useMemo` dependency list.

- [ ] **Step 5: Translate GitHub picker shell copy**

Replace:

```ts
const githubEmptyText = githubSearchResultsQuery.isFetching ? "Searching..." : "No results found.";
```

with:

```ts
const githubEmptyText = githubSearchResultsQuery.isFetching
  ? t("composer.github.searching")
  : t("composer.github.noResults");
```

Replace Combobox props:

```tsx
searchPlaceholder={t("composer.github.searchPlaceholder")}
title={t("composer.github.title")}
```

- [ ] **Step 6: Translate queue and attachment accessibility labels**

Update the queue track renderer to accept translated labels:

```ts
renderQueueTrack({
  queuedMessages,
  handleEditQueuedMessage,
  handleSendQueuedNow,
  editLabel: t("composer.attachments.editQueuedMessage"),
  sendNowLabel: t("composer.attachments.sendQueuedMessageNow"),
});
```

Update the attachment tray renderer to accept translated labels:

```ts
renderAttachmentTray({
  selectedAttachments,
  isComposerLocked,
  handleOpenAttachment,
  handleRemoveAttachment,
  labels: {
    openImage: t("composer.attachments.openImage"),
    removeImage: t("composer.attachments.removeImage"),
    openGithub: (kind: string, number: number) =>
      t("composer.attachments.openGithub", { kind, number }),
    removeGithub: (kind: string, number: number) =>
      t("composer.attachments.removeGithub", { kind, number }),
  },
});
```

Keep `kindLabel = item.kind === "pr" ? "PR" : "issue"` unchanged because these are GitHub domain terms.

- [ ] **Step 7: Run focused checks**

Run:

```bash
node node_modules/vitest/vitest.mjs run packages/app/src/i18n/resources.test.ts --bail=1
node node_modules/@typescript/native-preview/bin/tsgo.js --noEmit -p packages/app/tsconfig.json
node_modules/oxlint/bin/oxlint packages/app/src/composer/index.tsx
```

Expected: PASS.

- [ ] **Step 8: Format and commit Composer shell migration**

Run:

```bash
node_modules/oxfmt/bin/oxfmt packages/app/src/composer/index.tsx
git add packages/app/src/composer/index.tsx
git commit -m "feat: translate composer workflow chrome"
```

---

### Task 4: Translate Agent Controls Chrome

**Files:**

- Modify: `packages/app/src/composer/agent-controls/utils.ts`
- Modify: `packages/app/src/composer/agent-controls/utils.test.ts`
- Modify: `packages/app/src/composer/agent-controls/index.tsx`
- Modify: `packages/app/src/composer/agent-controls/mode-control.tsx`

- [ ] **Step 1: Convert hint helper to stable keys**

In `packages/app/src/composer/agent-controls/utils.ts`, replace `getAgentControlHint` with:

```ts
export type AgentControlHintKey =
  | "agentControls.hints.thinking"
  | "agentControls.hints.model"
  | "agentControls.hints.mode";

export function getAgentControlHintKey(selector: ExplainedAgentControl): AgentControlHintKey {
  switch (selector) {
    case "thinking":
      return "agentControls.hints.thinking";
    case "model":
      return "agentControls.hints.model";
    case "mode":
      return "agentControls.hints.mode";
    default:
      throw new Error("unreachable");
  }
}
```

- [ ] **Step 2: Update utility test**

In `packages/app/src/composer/agent-controls/utils.test.ts`, import `getAgentControlHintKey` instead of `getAgentControlHint`, rename the describe block, and assert:

```ts
expect(getAgentControlHintKey("thinking")).toBe("agentControls.hints.thinking");
expect(getAgentControlHintKey("model")).toBe("agentControls.hints.model");
expect(getAgentControlHintKey("mode")).toBe("agentControls.hints.mode");
```

- [ ] **Step 3: Translate `agent-controls/index.tsx`**

Import:

```ts
import { useTranslation } from "react-i18next";
```

Replace `getAgentControlHint` imports with `getAgentControlHintKey`.

Inside `ControlledAgentControls`, add:

```ts
const { t } = useTranslation();
```

Replace fallback and unknown labels:

```ts
const displayProvider = findOptionLabel(
  providerOptions,
  selectedProviderId,
  t("agentControls.provider.fallback"),
);
```

```ts
formattedThinkingOptions[0]?.label ?? t("agentControls.thinking.unknown");
```

Pass translated labels or `t` into `DesktopAgentControlsContent` and `SheetAgentControlsContent`:

```ts
labels={{
  selectProvider: t("agentControls.provider.select"),
  selectThinking: t("agentControls.thinking.select"),
  selectThinkingWithValue: (value) => t("agentControls.thinking.selectWithValue", { value }),
  openFeatures: t("agentControls.features.open"),
  thinkingTitle: t("agentControls.thinking.title"),
  featuresTitle: t("agentControls.features.title"),
  featureOn: t("agentControls.features.on"),
  featureOff: t("agentControls.features.off"),
  modelHint: t(getAgentControlHintKey("model")),
  thinkingHint: t(getAgentControlHintKey("thinking")),
}}
```

Use those labels in accessibility labels, tooltip text, `Combobox title`, `AdaptiveModalSheet header`, and mobile feature toggle state. Remove module-level `FEATURES_SHEET_HEADER` and build the header with `useMemo` inside `SheetAgentControlsContent`:

```ts
const featuresSheetHeader = useMemo<SheetHeader>(
  () => ({ title: labels.featuresTitle }),
  [labels.featuresTitle],
);
```

- [ ] **Step 4: Translate `mode-control.tsx` chrome**

Import:

```ts
import { useTranslation } from "react-i18next";
```

Inside `AgentModeControlView`, add:

```ts
const { t } = useTranslation();
```

Replace sheet header title and placeholder:

```ts
const sheetHeader = useMemo<SheetHeader>(
  () => ({
    title: t("agentControls.mode.title"),
    search: {
      onChange: setSearchQuery,
      placeholder: t("agentControls.mode.searchPlaceholder"),
      testID: "mode-search-input",
    },
  }),
  [t],
);
```

Replace accessibility label:

```tsx
accessibilityLabel={t("agentControls.mode.selectWithValue", {
  value: selectedModeLabel,
})}
```

Do not translate `selectedModeLabel`, option labels, provider names, or model names.

- [ ] **Step 5: Run focused checks**

Run:

```bash
node node_modules/vitest/vitest.mjs run packages/app/src/composer/agent-controls/utils.test.ts --bail=1
node node_modules/vitest/vitest.mjs run packages/app/src/i18n/resources.test.ts --bail=1
node node_modules/@typescript/native-preview/bin/tsgo.js --noEmit -p packages/app/tsconfig.json
node_modules/oxlint/bin/oxlint packages/app/src/composer/agent-controls/utils.ts packages/app/src/composer/agent-controls/index.tsx packages/app/src/composer/agent-controls/mode-control.tsx
```

Expected: PASS.

- [ ] **Step 6: Format and commit Agent Controls migration**

Run:

```bash
node_modules/oxfmt/bin/oxfmt packages/app/src/composer/agent-controls/utils.ts packages/app/src/composer/agent-controls/utils.test.ts packages/app/src/composer/agent-controls/index.tsx packages/app/src/composer/agent-controls/mode-control.tsx
git add packages/app/src/composer/agent-controls/utils.ts packages/app/src/composer/agent-controls/utils.test.ts packages/app/src/composer/agent-controls/index.tsx packages/app/src/composer/agent-controls/mode-control.tsx
git commit -m "feat: translate agent control chrome"
```

---

### Task 5: Translate Agent Stream Permission Wrapper

**Files:**

- Modify: `packages/app/src/agent-stream/view.tsx`

- [ ] **Step 1: Import translation hook**

Add:

```ts
import { useTranslation } from "react-i18next";
```

- [ ] **Step 2: Translate empty and scroll labels**

Update `renderListEmptyComponent` to accept `emptyText`:

```ts
function renderListEmptyComponent(input: {
  renderModel: AgentStreamRenderModel;
  emptyStateStyle: StyleProp<ViewStyle>;
  emptyText: string;
}): ReactNode {
  ...
  return (
    <View style={input.emptyStateStyle}>
      <Text style={stylesheet.emptyStateText}>{input.emptyText}</Text>
    </View>
  );
}
```

Inside `AgentStreamViewComponent`, add:

```ts
const { t } = useTranslation();
```

Pass:

```ts
const listEmptyComponent = useMemo(
  () =>
    renderListEmptyComponent({
      renderModel,
      emptyStateStyle,
      emptyText: t("agentStream.empty"),
    }),
  [renderModel, emptyStateStyle, t],
);
```

Replace scroll button label:

```tsx
accessibilityLabel={t("agentStream.scrollToBottom")}
```

- [ ] **Step 3: Translate permission wrapper labels**

Inside `PermissionRequestCard`, add:

```ts
const { t } = useTranslation();
```

Replace title fallback:

```ts
const title = isPlanRequest
  ? t("agentStream.permission.plan")
  : (request.title ?? request.name ?? t("agentStream.permission.required"));
```

Replace default actions:

```ts
label: t("agentStream.permission.deny"),
```

and:

```ts
label: isPlanRequest
  ? t("agentStream.permission.implement")
  : t("agentStream.permission.accept"),
```

Add `t` to the `resolvedActions` `useMemo` dependencies.

Replace footer question:

```tsx
{
  t("agentStream.permission.question");
}
```

Replace `PlanCard` proposed-plan title:

```tsx
title={t("agentStream.permission.proposedPlan")}
```

Keep:

```ts
message: "Denied by user",
```

unchanged because it is protocol/provider-facing response text, not just UI chrome.

- [ ] **Step 4: Run focused checks**

Run:

```bash
node node_modules/vitest/vitest.mjs run packages/app/src/i18n/resources.test.ts --bail=1
node node_modules/@typescript/native-preview/bin/tsgo.js --noEmit -p packages/app/tsconfig.json
node_modules/oxlint/bin/oxlint packages/app/src/agent-stream/view.tsx
```

Expected: PASS.

- [ ] **Step 5: Format and commit stream migration**

Run:

```bash
node_modules/oxfmt/bin/oxfmt packages/app/src/agent-stream/view.tsx
git add packages/app/src/agent-stream/view.tsx
git commit -m "feat: translate agent stream permission chrome"
```

---

### Task 6: Translate Agent Panel Wrapper States

**Files:**

- Modify: `packages/app/src/panels/agent-panel.tsx`

- [ ] **Step 1: Import translation hook**

Add:

```ts
import { useTranslation } from "react-i18next";
```

- [ ] **Step 2: Translate content-level state labels**

Inside `AgentPanelContent`, add:

```ts
const { t } = useTranslation();
```

Change:

```ts
const serverLabel = daemon?.label ?? connectionServerId ?? "Selected host";
```

to:

```ts
const serverLabel = daemon?.label ?? connectionServerId ?? t("agentPanel.unavailable.selectedHost");
```

Inside `AgentPanelBody`, add `const { t } = useTranslation();` and replace:

```tsx
<Text style={styles.errorText}>Agent not found</Text>
```

with:

```tsx
<Text style={styles.errorText}>{t("agentPanel.states.notFound")}</Text>
```

Replace:

```tsx
<Text style={styles.errorText}>Failed to load agent</Text>
```

with:

```tsx
<Text style={styles.errorText}>{t("agentPanel.states.failedToLoad")}</Text>
```

Keep diagnostic `lookupState.message` unchanged.

- [ ] **Step 3: Translate reconnect toast and archiving overlay**

Inside `ChatAgentContent`, add `const { t } = useTranslation();` and replace:

```ts
panelToast.api.show("Reconnecting...", {
```

with:

```ts
panelToast.api.show(t("agentPanel.states.reconnecting"), {
```

Add `t` to the effect dependencies.

Inside `ChatAgentReadyContent`, add `const { t } = useTranslation();` and replace:

```tsx
<Text style={styles.archivingTitle}>Archiving agent...</Text>
<Text style={styles.archivingSubtitle}>Please wait while we archive this agent.</Text>
```

with:

```tsx
<Text style={styles.archivingTitle}>{t("agentPanel.states.archivingTitle")}</Text>
<Text style={styles.archivingSubtitle}>{t("agentPanel.states.archivingSubtitle")}</Text>
```

- [ ] **Step 4: Translate unavailable Host wrapper copy**

Inside `AgentSessionUnavailableState`, add:

```ts
const { t } = useTranslation();
```

Replace the unknown-host title and description:

```tsx
<Text style={styles.errorText}>
  {t("agentPanel.unavailable.unknownHost", { serverLabel })}
</Text>
<Text style={styles.statusText}>{t("agentPanel.unavailable.addHost")}</Text>
```

Replace connecting/preparing copy:

```tsx
{
  isPreparingSession
    ? t("agentPanel.unavailable.preparingSession", { serverLabel })
    : t("agentPanel.unavailable.connecting", { serverLabel });
}
```

Replace subtitles:

```tsx
{
  isPreparingSession
    ? t("agentPanel.unavailable.showSoon")
    : t("agentPanel.unavailable.showWhenOnline");
}
```

Replace offline title and body:

```tsx
<Text style={styles.offlineTitle}>
  {t("agentPanel.unavailable.reconnectingTo", { serverLabel })}
</Text>
<Text style={styles.offlineDescription}>
  {t("agentPanel.unavailable.showAgainWhenReachable")}
</Text>
```

Keep `lastError` raw:

```tsx
{
  lastError ? <Text style={styles.offlineDetails}>{lastError}</Text> : null;
}
```

- [ ] **Step 5: Run focused checks**

Run:

```bash
node node_modules/vitest/vitest.mjs run packages/app/src/i18n/resources.test.ts --bail=1
node node_modules/@typescript/native-preview/bin/tsgo.js --noEmit -p packages/app/tsconfig.json
node_modules/oxlint/bin/oxlint packages/app/src/panels/agent-panel.tsx
```

Expected: PASS.

- [ ] **Step 6: Format and commit panel migration**

Run:

```bash
node_modules/oxfmt/bin/oxfmt packages/app/src/panels/agent-panel.tsx
git add packages/app/src/panels/agent-panel.tsx
git commit -m "feat: translate agent panel wrapper states"
```

---

### Task 7: Translate Draft Panel Descriptor Copy

**Files:**

- Modify: `packages/app/src/panels/draft-panel-descriptor.ts`
- Modify: `packages/app/src/panels/agent-panel-descriptor.test.tsx`

- [ ] **Step 1: Make descriptor labels injectable**

Change `buildDraftPanelDescriptor` input in `packages/app/src/panels/draft-panel-descriptor.ts` to:

```ts
export function buildDraftPanelDescriptor(input: {
  isCreating: boolean;
  pendingPrompt?: string | null;
  icon: ComponentType<PanelIconProps>;
  labels?: {
    newAgent: string;
    creatingAgent: string;
  };
}): PanelDescriptor {
  const { icon, isCreating, pendingPrompt } = input;
  const labels = input.labels ?? {
    newAgent: "New Agent",
    creatingAgent: "Creating agent",
  };
  const creatingLabel = pendingPrompt?.trim() || labels.newAgent;
  if (isCreating) {
    return {
      label: creatingLabel,
      subtitle: labels.creatingAgent,
      titleState: "ready",
      icon,
      statusBucket: "running",
    };
  }

  return {
    label: labels.newAgent,
    subtitle: labels.newAgent,
    titleState: "ready",
    icon,
    statusBucket: null,
  };
}
```

- [ ] **Step 2: Pass translations from descriptor caller**

Find the caller of `buildDraftPanelDescriptor` with:

```bash
rg -n "buildDraftPanelDescriptor" packages/app/src
```

In the React caller, import/use `useTranslation()` and pass:

```ts
labels: {
  newAgent: t("panels.draft.newAgent"),
  creatingAgent: t("panels.draft.creatingAgent"),
},
```

Do not call `useTranslation()` inside `draft-panel-descriptor.ts`; it is a pure descriptor builder.

- [ ] **Step 3: Update descriptor test**

In `packages/app/src/panels/agent-panel-descriptor.test.tsx`, add an assertion that injected labels are used:

```ts
const descriptor = buildDraftPanelDescriptor({
  isCreating: true,
  icon: TestIcon,
  labels: {
    newAgent: "新建 Agent",
    creatingAgent: "正在创建 Agent",
  },
});

expect(descriptor.label).toBe("新建 Agent");
expect(descriptor.subtitle).toBe("正在创建 Agent");
```

- [ ] **Step 4: Run focused checks**

Run:

```bash
node node_modules/vitest/vitest.mjs run packages/app/src/panels/agent-panel-descriptor.test.tsx --bail=1
node node_modules/vitest/vitest.mjs run packages/app/src/i18n/resources.test.ts --bail=1
node node_modules/@typescript/native-preview/bin/tsgo.js --noEmit -p packages/app/tsconfig.json
node_modules/oxlint/bin/oxlint packages/app/src/panels/draft-panel-descriptor.ts packages/app/src/panels/agent-panel-descriptor.test.tsx
```

Expected: PASS.

- [ ] **Step 5: Format and commit descriptor migration**

Run:

```bash
node_modules/oxfmt/bin/oxfmt packages/app/src/panels/draft-panel-descriptor.ts packages/app/src/panels/agent-panel-descriptor.test.tsx
git add packages/app/src/panels/draft-panel-descriptor.ts packages/app/src/panels/agent-panel-descriptor.test.tsx
git commit -m "feat: translate draft agent panel labels"
```

---

### Task 8: Document Batch 2 Progress and Final Verification

**Files:**

- Modify: `docs/i18n.md`

- [ ] **Step 1: Add migration progress note**

In `docs/i18n.md`, below the staged migration list, add:

```md
## Migration Progress

- Batch 1 completed: app shell and shared UI chrome.
- Batch 2 completed: Composer input, Composer attachments, agent controls, permission prompt wrapper copy, and agent panel wrapper states.
```

- [ ] **Step 2: Format changed files**

Run:

```bash
node_modules/oxfmt/bin/oxfmt docs/i18n.md packages/app/src/i18n/resources/en.ts packages/app/src/i18n/resources/zh-CN.ts packages/app/src/i18n/resources.test.ts packages/app/src/composer/input/input.tsx packages/app/src/composer/index.tsx packages/app/src/composer/agent-controls/utils.ts packages/app/src/composer/agent-controls/utils.test.ts packages/app/src/composer/agent-controls/index.tsx packages/app/src/composer/agent-controls/mode-control.tsx packages/app/src/agent-stream/view.tsx packages/app/src/panels/agent-panel.tsx packages/app/src/panels/draft-panel-descriptor.ts packages/app/src/panels/agent-panel-descriptor.test.tsx
```

- [ ] **Step 3: Run targeted tests**

Run:

```bash
node node_modules/vitest/vitest.mjs run packages/app/src/i18n/resources.test.ts --bail=1
node node_modules/vitest/vitest.mjs run packages/app/src/i18n/locales.test.ts --bail=1
node node_modules/vitest/vitest.mjs run packages/app/src/composer/agent-controls/utils.test.ts --bail=1
node node_modules/vitest/vitest.mjs run packages/app/src/panels/agent-panel-descriptor.test.tsx --bail=1
```

Expected: PASS.

- [ ] **Step 4: Run app typecheck**

Run:

```bash
node node_modules/@typescript/native-preview/bin/tsgo.js --noEmit -p packages/app/tsconfig.json
```

Expected: PASS.

- [ ] **Step 5: Run lint**

Run:

```bash
node_modules/oxlint/bin/oxlint
```

Expected: PASS.

- [ ] **Step 6: Run language smoke E2E**

Run:

```bash
PATH="$PWD/node_modules/.bin:$PATH" node node_modules/playwright/cli.js test packages/app/e2e/settings-i18n.spec.ts --config packages/app/playwright.config.ts --project='Desktop Chrome'
```

Expected: PASS.

If Playwright leaves temporary `wrangler dev` or `expo start --web` processes running, stop only those temporary processes. Do not restart or kill the main Paseo daemon on port 6767.

- [ ] **Step 7: Commit docs and verification note**

Run:

```bash
git add docs/i18n.md
git commit -m "docs: record composer i18n migration progress"
```

- [ ] **Step 8: Push branch and update PR**

Run:

```bash
git push fork feat/client-i18n
```

Then update PR `https://github.com/getpaseo/paseo/pull/1282` with:

```md
### Batch 2: Composer and agent workflow

- Added Composer, agent controls, agent stream permission, agent panel, and draft panel translation resources.
- Migrated client-owned Composer input, attachment menu, GitHub picker, Agent Controls chrome, permission wrapper copy, and Agent panel wrapper states.
- Preserved provider/model names, provider-defined feature/mode labels, raw daemon/agent output, and protocol-facing permission response payloads.

Verification:

- `node node_modules/vitest/vitest.mjs run packages/app/src/i18n/resources.test.ts --bail=1`
- `node node_modules/vitest/vitest.mjs run packages/app/src/i18n/locales.test.ts --bail=1`
- `node node_modules/vitest/vitest.mjs run packages/app/src/composer/agent-controls/utils.test.ts --bail=1`
- `node node_modules/vitest/vitest.mjs run packages/app/src/panels/agent-panel-descriptor.test.tsx --bail=1`
- `node node_modules/@typescript/native-preview/bin/tsgo.js --noEmit -p packages/app/tsconfig.json`
- `node_modules/oxlint/bin/oxlint`
- `PATH="$PWD/node_modules/.bin:$PATH" node node_modules/playwright/cli.js test packages/app/e2e/settings-i18n.spec.ts --config packages/app/playwright.config.ts --project='Desktop Chrome'`
```

---

## Self-Review Checklist

- [ ] Resource coverage: every Batch 2 local copy cluster has an English and Simplified Chinese key.
- [ ] Boundary check: provider names, model names, provider feature labels/tooltips, provider mode labels, agent output, daemon output, terminal/log text, file paths, and raw server/protocol errors remain untranslated.
- [ ] Protocol check: permission deny response payload remains `"Denied by user"`.
- [ ] Placeholder-marker scan: this plan contains no unfinished-marker words or unspecified implementation steps.
- [ ] Verification check: resource parity, targeted helper tests, app typecheck, lint, and the existing settings language E2E are run before claiming Batch 2 complete.

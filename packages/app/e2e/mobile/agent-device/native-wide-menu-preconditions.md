# Native wide menu flows

Run these on a connected task-owned tablet with the current development app and Metro bundle. `workspace-tabs-scroll` asserts the wide tab row; also pass an explicit tablet `--device` so a landscape phone above the breakpoint cannot stand in for tablet coverage. The context meter flow requires an agent tab with reported token usage selected. Its tooltip assertion uses a stable ID emitted only by the open content.

The agent tab menu flow requires an existing agent tab. Set `AGENT_ID` to the ID of that agent and `TAB_ID` to its workspace tab ID (shown in the `workspace-tab-context-*` test ID) before replay. The flow long-presses the tab and selects **Copy agent id**. It does not claim that an arrow tap works.

The sidebar Rename flow requires a selected workspace and its `WORKSPACE_KEY` (shown in the `sidebar-workspace-kebab-*` test ID). It opens the row's actions, opens Rename, then cancels without changing the workspace name. This covers the currently working row reported in #5226.

For the native-wide tooltip dismissal flows, select an agent with reported token usage so `context-window-meter` exists. A fresh load-test stream can supply usage. The Maestro flows assert that the tooltip is absent after dismissal, then reopen it to prove the control is usable. The overlay dismissal flows assert that the tab menu and Rename dialog are absent after selection/cancel. On iPad the focused Rename input can consume the first Cancel tap; the iOS Maestro flow conditionally repeats that tap only while the dialog remains visible.

For tab scrolling, first create enough tabs for actual horizontal overflow. The Android replay was validated with nine tabs and the Explorer sidebar open; the iPad replay was validated with six tabs. Set `DRAFT_ID` to a visible draft tab, `AGENT_ID` to the first visible agent tab, `OTHER_AGENT_ID` to another agent tab, and `TAB_ID` to the first agent's workspace tab ID. The short pan starts on an agent chip while a draft is selected; the draft composer must remain active. The flow then checks a stationary long press and an ordinary tap. Keep the tab row scrolled to its beginning before running the iPad flow.

Android Pixel Tablet API 36.1:

```sh
agent-device replay packages/app/e2e/mobile/agent-device/native-wide-context-meter.android.ad --platform android --device paseo-tablet-p1-api36 --env OTHER_AGENT_ID=<other-agent-id>
agent-device replay packages/app/e2e/mobile/agent-device/native-wide-agent-tab-menu.android.ad --platform android --device paseo-tablet-p1-api36 --env AGENT_ID=<existing-agent-id> --env TAB_ID=<existing-tab-id>
agent-device replay packages/app/e2e/mobile/agent-device/native-wide-sidebar-rename.android.ad --platform android --device paseo-tablet-p1-api36 --env WORKSPACE_KEY=<selected-workspace-key>
agent-device replay packages/app/e2e/mobile/agent-device/native-wide-tooltip-dismissal.android.yaml --maestro --platform android --device paseo-tablet-p1-api36
agent-device replay packages/app/e2e/mobile/agent-device/native-wide-overlay-dismissal.android.yaml --maestro --platform android --device paseo-tablet-p1-api36 --env AGENT_ID=<existing-agent-id> --env TAB_ID=<existing-tab-id> --env WORKSPACE_KEY=<selected-workspace-key>
agent-device replay packages/app/e2e/mobile/agent-device/native-wide-tab-scroll.android.ad --platform android --device paseo-tablet-p1-api36 --env DRAFT_ID=<visible-draft-id> --env AGENT_ID=<existing-agent-id> --env OTHER_AGENT_ID=<other-agent-id> --env TAB_ID=<existing-tab-id>
```

iPad Pro 11-inch (M5), iOS 26.5, from the Namespace Mac checkout:

```sh
agent-device replay packages/app/e2e/mobile/agent-device/native-wide-context-meter.ios.ad --platform ios --device 'iPad Pro 11-inch (M5)' --env OTHER_AGENT_ID=<other-agent-id>
agent-device replay packages/app/e2e/mobile/agent-device/native-wide-agent-tab-menu.ios.ad --platform ios --device 'iPad Pro 11-inch (M5)' --env AGENT_ID=<existing-agent-id> --env OTHER_AGENT_ID=<other-agent-id> --env TAB_ID=<existing-tab-id>
agent-device replay packages/app/e2e/mobile/agent-device/native-wide-sidebar-rename.ios.ad --platform ios --device 'iPad Pro 11-inch (M5)' --env WORKSPACE_KEY=<selected-workspace-key>
agent-device replay packages/app/e2e/mobile/agent-device/native-wide-tooltip-dismissal.ios.yaml --maestro --platform ios --device 'iPad Pro 11-inch (M5)'
agent-device replay packages/app/e2e/mobile/agent-device/native-wide-overlay-dismissal.ios.yaml --maestro --platform ios --device 'iPad Pro 11-inch (M5)' --env WORKSPACE_KEY=<selected-workspace-key>
agent-device replay packages/app/e2e/mobile/agent-device/native-wide-tab-scroll.ios.ad --platform ios --device 'iPad Pro 11-inch (M5)' --env DRAFT_ID=<visible-draft-id> --env AGENT_ID=<existing-agent-id> --env OTHER_AGENT_ID=<other-agent-id> --env TAB_ID=<existing-tab-id>
```

# Tab switcher sheet drag on iPhone

Run on a task-owned iPhone 17 simulator (402×874 points, portrait) with the development bundle loaded and a connected isolated host. Select a workspace whose first tab is an agent and whose next 11 tabs are terminals, and select the agent tab. Dismiss the notification entitlement toast.

The sheet exposes its rows to XCUITest as one "Bottom Sheet" element, so the flow taps fixed points and asserts which tab opens. The sheet opens at 60%, where its handle is at y=350, and expands to 90%, where its handle is at y=87.

1. A swipe up on the list must expand the sheet. The tap at y=300 then lands on the fourth row and opens a terminal. Without the expansion it lands on the backdrop, and no terminal opens.
2. A swipe down on the list at 90% must collapse the sheet. The tap at y=424 then lands on the first row and opens the agent. Without the collapse it lands on the sixth row, which is a terminal.

The flow ends on the agent tab, so you can replay it. Replay it on the Namespace Mac with an explicit device:

```sh
agent-device replay packages/app/e2e/mobile/agent-device/native-tab-switcher-sheet-drag.ios.ad --platform ios --device 'iPhone 17'
```

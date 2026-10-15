# Native wide terminal device flows

Run these against a connected task-owned tablet with the current development app, Metro bundle, and a workspace whose terminal opens successfully. The flows assert `terminal-virtual-keyboard-native-wide`, which is emitted only for a native noncompact window. That assertion makes a compact phone fail before any PTY success marker. A landscape phone that reaches the noncompact breakpoint is excluded by the explicit tablet `--device` argument; do not rely on the runner's default device.

Android Pixel Tablet API 36.1:

```sh
agent-device replay packages/app/e2e/mobile/agent-device/native-terminal-wide-keybar.android.ad --platform android --device paseo-tablet-p1-api36
```

iPad Pro 11-inch (M5), iOS 26.5: from the Namespace Mac checkout, prefill the simulator clipboard with the command below, then run the Maestro compatibility flow. Its `runFlow.when.visible` presses **Allow Paste** only if the iOS sheet appears; every other action and output assertion remains strict. The clipboard payload contains `PASTE_OK`, while only executed PTY output contains `__AD_IOS_PASTE_OK__`.

```sh
printf '%s' "printf '__AD_IOS_%s__\\n' PASTE_OK" | xcrun simctl pbcopy E49C88C3-9A60-4715-B63A-881498D1991A
agent-device replay packages/app/e2e/mobile/agent-device/native-terminal-wide-paste.ios.yaml --maestro --platform ios --device 'iPad Pro 11-inch (M5)'
```

The unsigned simulator build used for phase 1 raises a known `getRegistrationInfoAsync` entitlement overlay on launch. The flow dismisses only that exact development error and asserts it is gone before touching terminal controls; another overlay still fails the flow. `native-terminal-wide-keybar.ios.ad` separately proves that the wide iPad bar sends Enter to the PTY. It needs no clipboard permission. The Maestro flow above is the paste gate for both first-run and already-granted states.

# Native question option preview

`native-question-option-preview.android.ad` checks that every line of a long option preview is reachable on Android. Before replay, open a mock agent prompted with `emit synthetic questions` so its question card shows the first question, on a phone-sized emulator (validated on a 1080×1920 API 35 AVD). The flow opens the `rollout` question, drags slowly up from inside the "Behind feature flag" preview, and asserts the preview's last line is visible.

```sh
agent-device replay packages/app/e2e/mobile/agent-device/native-question-option-preview.android.ad --platform android --serial emulator-5554
```

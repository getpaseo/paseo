# Native compact workspace Back flow

`native-compact-workspace-back.android.ad` covers Android Back in a compact workspace. Start on a phone with a workspace open and its chat showing, the workspace list and the file explorer closed.

Back from the file explorer returns to the chat. Back from the chat opens the workspace list, and Back from the list leaves the app, as in other chat apps. The flow ends with Paseo in the background, so it can be replayed after reopening the workspace.

```sh
agent-device replay packages/app/e2e/mobile/agent-device/native-compact-workspace-back.android.ad --platform android --serial emulator-5590 --metro-port 8137
```

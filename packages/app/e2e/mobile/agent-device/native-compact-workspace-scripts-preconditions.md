# Native compact workspace scripts flow

`native-compact-workspace-scripts.android.ad` covers live script status in the compact ⋯ → Scripts sheet when nothing else keeps the host directory live. Start on a phone with a workspace open, the sidebar closed, and no agent tab selected. A viewed agent tab or the open sidebar hides the failure, because either one keeps the directory subscribed.

The workspace's `paseo.json` needs a long-running plain script, stopped before the run. `SCRIPT` defaults to `worker`:

```json
{ "scripts": { "worker": { "command": "node -e \"setInterval(() => {}, 1000)\"" } } }
```

The flow starts the script, checks that Stop flips its page to Run, runs it again, and checks that Restart brings it back to running with no other interaction. It ends with the script stopped and the sheet dismissed, so it can be replayed.

```sh
agent-device replay packages/app/e2e/mobile/agent-device/native-compact-workspace-scripts.android.ad --platform android --serial emulator-5590 --metro-port 8137
```

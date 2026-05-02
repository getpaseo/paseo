# Electron Find QA

Run only the Electron browser find harness:

```bash
npm run test:e2e --workspace=@getpaseo/app -- find-in-pane-electron.spec.ts --project "Desktop Chrome" --workers=1
```

The spec starts a fresh desktop app from the current worktree with:

- isolated `PASEO_HOME` under `/tmp/paseo-find-pane-electron-rerun/home`
- isolated Electron user data under `/tmp/paseo-find-pane-electron-rerun/electron-user-data`
- `PASEO_LISTEN=127.0.0.1:0`, so it must not use port `6767`
- a local HTTP page containing three `electronneedle` matches

Expected pass output: one Playwright test passes. Evidence lands in
`/tmp/paseo-find-pane-electron-rerun/`:

- `electron-find-evidence.json` with timestamps, listener counts, request IDs, match events, and cleanup calls
- `diagnostic-<timestamp>.md` with the latest run diagnosis
- `electron-find-*.png` screenshots
- `electron-dev.log` from the spawned desktop process

Failure modes:

- Timeout waiting for `workspace-new-browser`: the desktop app opened, but the workspace did not render tab actions.
- LogBox screenshot after browser open: browser pane crashed before find could run.
- Timeout waiting for `foundEvents`: `webview.findInPage()` returned a request ID, but renderer-side `found-in-page` never arrived.
- Counter mismatch: `found-in-page` arrived, but the shared `FindBar` state did not update to the expected current/total.
- Close/Esc mismatch: native selection or shared find cleanup did not finish.

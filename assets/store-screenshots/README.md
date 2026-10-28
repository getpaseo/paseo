# Store screenshots

Five panels for the App Store and Google Play, in phone and tablet sets, made from native captures of the real app. Both sets tell the same story with the same copy; only the capture, the device frame and the callouts change.

| #   | Headline                                | Capture                                                                | Phone callout                                | Tablet callout                        |
| --- | --------------------------------------- | ---------------------------------------------------------------------- | -------------------------------------------- | ------------------------------------- |
| 1   | Run many coding agents at once          | Sidebar grouped by status: Needs input, Ready to review, Working, Done | — (agent marks in the background)            | — (agent marks in the background)     |
| 2   | Your full dev environment on your phone | Agent chat: reasoning, tool calls, final summary                       | —                                            | — (Changes pane open beside the chat) |
| 3   | Ask an agent to change the app itself   | A chat asking for a plugin, the turn collapsed, the new Deploys pill   | The plugin's Preview deploys sheet           | The plugin's Deploys popover          |
| 4   | Review the diff before you merge        | `daemon-client.ts` diff with removed and added lines                   | Jump to file: four changed files with counts | — (the full-width diff reads as is)   |
| 5   | A real terminal in every workspace      | `git status` and a vitest run in the same worktree                     | The passing test tree                        | The passing test tree                 |

On tablets, panel 2 says "on your tablet" and panel 3 calls the popover a panel. A scene overrides its copy per device in `render.mjs`.

## Creative direction

The panels follow paseo.sh:

- **Canvas:** the site's `#101615` background.
- **Type:** centred SF Pro headlines in sentence case, with no closing period. Every headline wraps to exactly two lines.
- **Sublines:** one plain grey sentence on one line that says what you can do. The renderer fails if a headline or subline wraps differently, because the device is placed from that fixed text height.
- **Agent marks:** panel 1 scatters faded, rotated, monochrome marks of the agents featured on the homepage behind the device. They are rendered from `packages/website/src/components/agent-icons.tsx`, so they follow the site.
- **Device:** dark-mode captures in a plain black frame; the iPhone frame has a Dynamic Island. The device starts a fixed gap below the text and runs just off the bottom edge, so a taller canvas gets a larger device instead of a larger gap. A canvas too narrow for that, like a 3:4 iPad on Google's 9:16 tablet canvas, shows the whole device at full width with the text and device centred.
- **Callouts:** a callout lifts one region of a capture out of the device, larger than the device around it, so the detail reads at store thumbnail size. On tablets, place callouts over empty screen so they do not hide the context they explain.

Everything on screen is real app UI showing one story. The hero agent adds jitter to the reconnect backoff in this repository. Its diff, test run and terminal come from a real worktree. The other workspaces fill the sidebar's status groups.

Panel 3 shows a real plugin. `demo/preview-deploys/` is a trusted local plugin that adds a Deploys composer pill; its popover opens as a sheet on phones and as a popover on tablets. The deploys it lists are sample data. The demo host installs it, and a scripted agent in the "Build a preview deploys plugin" workspace plays the turn that writes it.

## Files

- `raw/iphone/`: native 1320 × 2868 captures from an iPhone 16 Pro Max simulator. `files.png` and `plugin-sheet.png` are the sources for the Jump to file and Preview deploys callouts.
- `raw/ipad/`: native 2064 × 2752 captures from an iPad Pro 13-inch (M4) simulator. `plugin-sheet.png` is the source for the Deploys popover callout.
- `render.mjs`: the layout, copy and callout crops. Edit `SCENES`, `DEVICES` and `STORES` there.
- `demo/`: the staged demo host the captures come from.
- `output/apple/`: 1320 × 2868 for the iPhone 6.9-inch slot.
- `output/google/`: 1440 × 2560 (9:16) phone screenshots, reusing the iPhone captures.
- `output/apple-ipad/`: 2064 × 2752 for the iPad 13-inch slot.
- `output/google-tablet/`: 1800 × 3200 (9:16) tablet screenshots, reusing the iPad captures.
- `output/preview.png`: contact sheet with one row per store, for review only. It is ignored by Git; do not upload it to a store.

All exports are opaque RGB PNGs.

## Render

```sh
SF_FONT_DIR=/path/to/fonts node assets/store-screenshots/render.mjs
```

`SF_FONT_DIR` must hold `SFNS.ttf` copied from a Mac's `/System/Library/Fonts`. On macOS the renderer finds it without the variable. SF Pro is not redistributable, so it is not in the repository. The renderer fails rather than fall back to another font.

Each capture and callout is resized with Lanczos to the exact pixels it fills, and the page renders at device scale 1. Do not render at a higher scale and downsample: Chrome's image downscaling is what made earlier exports look soft and aliased.

Open `output/preview.png` and at least one full-size panel per store before you call a render done. The line guard catches wrapping, not a callout that covers the wrong thing.

Callout crops are in native capture pixels. To find them, overlay a 100 px grid on the capture with sharp and read the coordinates off it.

## Recapture

1. Stage the demo host. It runs an in-process daemon on port 7791 with scripted Claude Code and Codex clients, a local clone of this repository as the `paseo` project, real worktrees, and a terminal in the hero worktree:

   ```sh
   npx tsx assets/store-screenshots/demo/stage.mts
   ```

   Each run re-clones the repository into the demo home, so stale worktrees from an earlier run do not block it. The hero agent is paced so it reports a realistic "Worked for" time. Wait for `READY` in its output.

2. Start Metro against it on a free port. When the simulator runs on another Mac, forward Metro and the daemon to it. Other agents may already hold a Metro port; pick another one rather than stopping theirs.

   ```sh
   EXPO_PUBLIC_LOCAL_DAEMON=127.0.0.1:7791 npm run start:expo --workspace=@getpaseo/app -- --port <port>
   ssh -o ExitOnForwardFailure=yes -R <port>:127.0.0.1:<port> -R 7791:127.0.0.1:7791 <mac-host>
   ```

3. On the simulator, install and open the dev client (`sh.paseo.debug`) at `http://127.0.0.1:<port>`. Use an iPhone 16 Pro Max for the phone set and an iPad Pro 13-inch (M4) in portrait for the tablet set.
   - Set dark appearance and override the status bar to 9:41 with full battery and signal (`xcrun simctl status_bar <device> override`).
   - On first launch, accept the open-in-app dialog, decline notifications, turn off the dev client's Tools button, and close any error toast. `agent-device react-native dismiss-overlay` clears overlays.
   - Name the host "MacBook Pro" and set the sidebar badge to Hidden.
   - Group the sidebar by status.
   - If you reset the simulator, reinstall the dev client.

4. Capture the sidebar first. Opening a "Ready to review" workspace marks it done. Select a Working row before you capture.

5. Capture every screen at native density. `agent-device screenshot` defaults to 1x, which is too soft for the store:

   ```sh
   agent-device screenshot /tmp/sidebar.png --pixel-density 3 --session store   # iPhone: 1320 × 2868
   agent-device screenshot /tmp/sidebar.png --pixel-density 2 --session store   # iPad: 2064 × 2752
   ```

   - **Chat:** expand the tool-call group and scroll to the bottom. On iPad, open Explorer → Changes beside the chat.
   - **Diff:** on iPhone, Explorer → Changes, then use Jump to file to reach `daemon-client.ts`. On iPad, collapse the sidebar, open a Diff tab from the main area's **+** menu and scroll to the `daemon-client.ts` hunks.
   - **Terminal:** the second workspace tab. Type the commands with `npm run cli -- terminal send-keys --host 127.0.0.1:7791 <terminal-id> "<text>" Enter` instead of the simulator keyboard, then dismiss the software keyboard.
   - **Plugin:** the "Build a preview deploys plugin" workspace with the turn collapsed, then tap **Deploys** for `plugin-sheet.png`. After editing the plugin, reload it with `npm run cli -- plugin reload --host 127.0.0.1:7791 preview-deploys`.

6. Copy the captures into `raw/iphone/` or `raw/ipad/` under the names `render.mjs` uses, render, and check the preview.

Dimensions are checked against [Apple's screenshot specifications](https://developer.apple.com/help/app-store-connect/reference/app-information/screenshot-specifications/) and [Google Play's preview asset requirements](https://support.google.com/googleplay/android-developer/answer/9866151?hl=en).

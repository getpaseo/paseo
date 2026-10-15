# Paseo media fork — read this first when anything breaks.

## Purpose
Paseo fork: inline YouTube playback + mobile long-press downloads in chat. Web UI only, daemon-served, PWA-installed. No native builds. One media layer for OpenCode / Pi / Claude / Codex.

## Why a fork, not a plugin
Plugins have no WebView primitive (no inline player), can only replace whole timeline messages (no inline cards), and have no download hook. Verified against plugin docs + timeline API. The `youtube-cards` plugin stays as the stock-client fallback.

## Specs
- Player: `react-native-webview` (already a dep, `^13.16.0`) → `youtube-nocookie` embed. Required props: `javaScriptEnabled`, `allowsInlineMediaPlayback`. Embedding-disabled videos fall back to thumbnail card.
- Detection: YouTube/image/URL regexes live in the plugin's `transform-cards.ts` — port, don't rewrite. Bare URLs travel the linkify path (`linkify: true`), never the fence registry.
- Download (existing, we only unblock): menu item → `useFileDownload` → `download-store.ts` (web: Blob + anchor `download`; native: expo-file-system) → `DownloadToast`.
- Ship: `build:daemon-web-ui` → `packages/server/dist/server/web-ui`, daemon mounts at `/`, manifest scope intact.

## Files touched (the whole fork)
1. `packages/app/src/components/markdown/fence/youtube/index.tsx` (NEW) — WebView player. Never conflicts.
2. `packages/app/src/components/markdown/fence/index.tsx` — one map line registers it. YT fences render as code = this line stale.
3. `packages/app/src/components/markdown/renderer.tsx` (+ `link-children.ts`) — bare YouTube URLs routed to player. Bare links stay links = regex here.
4. `packages/app/src/components/ui/context-menu.tsx` — `handleLongPress` opens menu on touch-web (delete the `isWeb` early-return, ~line 157) AND extend `coerceEventPoint` to read `changedTouches[0]` with row-anchor fallback — without this the fix fails silently on touch devices.
5. `packages/app/src/components/tree-primitives.tsx` — `-webkit-touch-callout: none` + `user-select: none` on `workspaceTreeRowStyles.row`. Safari shows its callout = this style missing.

## Failure → culprit
- YT link, no player → #3 regex / #2 registration.
- Player black → #1 WebView props / embedding disabled.
- Long-press selects only → #4 early-return back, or TouchEvent coercion missing.
- Safari callout covers menu → #5 styles.
- Download starts, file broken → `download-store.ts` (upstream).
- Merge conflict after sync → only possible in files 2–5.

## Open verifications
- Device-confirm long-press anchor on iOS Safari (fallback already coded: anchor to row).

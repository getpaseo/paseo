# Changelog

## 0.1.42 - 2026-04-01

### Fixed
- Fixed Claude Code failing to launch on Windows when installed to a path with spaces (e.g. `C:\Program Files\...`).

## 0.1.41 - 2026-04-01

### Fixed
- Fixed agent spawning on Windows — all providers (Claude, Codex, OpenCode) now use shell mode so npm shims and `.cmd` wrappers resolve correctly.
- Fixed terminal creation on Windows defaulting to a Unix shell instead of `cmd.exe`.
- Fixed path handling across the app to support Windows drive-letter paths (`C:\...`) and UNC paths (`\\...`).
- Fixed executable resolution on Windows to work with `nvm4w` and similar Node version managers.
- Eliminated white flash on window resize in dark mode by setting the native window background color to match the theme.
- Fixed titlebar drag region — replaced the fragile pointer-event approach with VS Code's proven static CSS `app-region: drag` pattern.
- Fixed context menu for copy/paste across the desktop app.
- Fixed shortcut rebinding UI to show held modifier keys and recognize additional keys (Tab, Delete, Home, End, Page Up/Down, Insert, F1–F12).
- Removed the 40-item cap on activity timeline output so long agent sessions display their full history.

### Improved
- Improved light mode theming with dedicated workspace background, scrollbar handle colors, and lighter shadows.
- Window controls overlay on Windows/Linux reduced from 48px to 29px height for a more compact titlebar.

## 0.1.40 - 2026-04-01

### Added
- Workspace tabs can now be closed in batches.

### Improved
- Provider model lists are now cached per server and provider, reducing redundant model lookups in the UI.

### Fixed
- OpenCode reasoning content no longer appears duplicated as assistant text.
- Daemon no longer crashes when a Codex binary is missing or fails to spawn.
- Archive tab now correctly reconciles agent visibility after archiving.
- File diff tracking in workspaces now works correctly on Linux.
- iPad layout now renders correctly in desktop mode.
- macOS auto-updater now correctly delivers both arm64 and x64 binaries — previously whichever architecture finished building last would overwrite the other's update manifest.

## 0.1.39 - 2026-03-30

### Added
- **Terminal management from the CLI** — new `paseo terminal` command group lets you list, create, and interact with workspace terminals without leaving your terminal.
- **Material file icons in the explorer** — the file explorer tree now shows language-specific icons (TypeScript, JSON, Markdown, etc.) so you can spot files at a glance.

### Fixed
- Fixed iOS sidebar scroll flicker caused by redundant overflow clipping.
- Centralized window controls padding into a shared hook, eliminating layout inconsistencies across platforms.

## 0.1.38 - 2026-03-30

### Fixed
- Fixed daemon startup race where the app could time out connecting on first launch because the PID file advertised a listen address before the server was ready.
- Fixed daemon log rotation losing startup traces — trace-level WebSocket logs no longer include full message payloads.

## 0.1.37 - 2026-03-29

### Added
- Custom window controls on Windows and Linux — the native titlebar is replaced with overlay controls that match the app's design.
- Desktop file logging with electron-log for easier debugging of daemon and app issues.

### Fixed
- Fixed broken PATH propagation and Claude binary resolution on Windows.
- Dictation errors now show a visible toast instead of failing silently.

## 0.1.36 - 2026-03-27

### Fixed
- Fixed Windows drive-letter path handling across the codebase.
- Fixed stale Nix hash with automatic lockfile-change detection.

### Added
- Added metrics collection and terminal performance tests.

## 0.1.35 - 2026-03-26

### Improved
- Faster app startup by redirecting to the welcome screen immediately and showing host connection status inline.
- Codex file deletions now display correctly as removed lines in diffs.
- OpenCode questions are now surfaced in the permission UI.

### Fixed
- Fixed queued prompt dispatch after idle transition.
- Replaced bash-only `mapfile` with a portable `while-read` loop in the chat script.

### Added
- Added support for Nix and NixOS installation.

## 0.1.34 - 2026-03-25

### Added
- Added `paseo archive` as a top-level alias for `paseo agent archive`.
- Added the `PASEO_AGENT_ID` environment variable for Claude and Codex agents.
- Added a redesigned command autocomplete with a detail card and dropdown styling.
- Linked Android download surfaces to the Google Play Store.

### Improved
- Autonomous turns now complete gracefully on interrupt instead of being canceled.
- Thinking/model selection now always resolves to a real option instead of showing a generic Default choice.
- Restored per-provider form preferences and removed the Auto model fallback.
- Improved Codex activity logs with clearer tool-call summaries.
- Reduced unnecessary re-renders in the agent panel and input area for smoother interaction.
- Improved chat transcript readability.

### Fixed
- Fixed `paseo send --no-wait` not taking effect.
- Fixed stale abort results contaminating replacement turns after an interrupt.
- Fixed Claude interrupt handling and autonomous wake reliability.
- Fixed nested Claude Code session detection and provider availability checks.
- Fixed agent input focus scoping across panels.
- Fixed terminal snapshot ordering when subscribing.
- Fixed `chat read --since` to accept message IDs.
- Fixed keyboard pane focus syncing with the active panel.
- Fixed assistant text selection on web.
- Fixed archived-agent notifications still appearing in chat rooms.
- Fixed the attach-images button interaction in the message composer.
- Pruned wrong-platform native binaries from Electron desktop builds.

## 0.1.33 - 2026-03-23

### Fixed
- Fixed the desktop app failing to reopen after closing on macOS — the daemon and agent processes were registering with Launch Services as instances of the main app, blocking subsequent launches.
- Fixed dictation not working in the packaged desktop app — the microphone entitlement was missing from the hardened runtime configuration.
- Fixed leaked Claude Code child processes when agents were closed — the SDK query stream was not being properly shut down.
- The notification test button now surfaces errors instead of failing silently.

## 0.1.32 - 2026-03-23

### Added
- Fully rebindable keyboard shortcuts with chord support — all shortcuts are now declarative with proper Cmd (Mac) vs Ctrl (Windows/Linux) separation.
- Migrated the desktop app from Tauri to Electron, with macOS notarization, code signing, and Linux Wayland support.
- Added line numbers and word-wrap toggle to file previews.
- Added an archived agent callout with an unarchive button so you can restore agents directly from the chat view.
- Added workspace kind indicators in the sidebar (e.g. worktree vs standalone).
- Expanded diff syntax highlighting to cover more languages.
- Added status bar tooltips for project and agent status.

### Improved
- Redesigned the mobile tab switcher as a compact header row with quick access to new agents and terminals.
- Streamlined workspace creation — worktrees are now created inline with a single action instead of a multi-step flow.
- Agent history now streams from disk on reconnect, so you see past messages immediately instead of a blank screen.
- Automatic cleanup of stale workspaces: deleted worktree directories and fully-archived workspaces are pruned automatically.
- After archiving a workspace, the app now redirects to the next available workspace instead of leaving you on a dead screen.
- Reopening an archived agent tab now keeps it open instead of collapsing back to archived state.
- Reduced unnecessary re-renders across the workspace screen, sidebar, and agent list for smoother scrolling and interaction.
- Agent list no longer refreshes in the background when the screen is unfocused, saving resources.
- Desktop key repeat now works correctly on macOS.
- Desktop notifications on macOS are more reliable.
- Daemon startup no longer blocks on model downloads.
- Better error messages from the daemon — RPC errors now include the actual underlying details.

### Fixed
- Fixed user messages appearing as assistant output in the timeline when messages contained structured content blocks.
- Fixed archived workspace routing so navigating to an archived session no longer breaks the app.
- Fixed Linux AppImage failing to launch on Wayland-only desktops.
- Fixed desktop window drag coordinates being applied when they shouldn't be.

## 0.1.30 - 2026-03-19

### Added
- Added terminal tabs, split pane controls, and drop previews for workspace layouts.
- Added a combined model selector and agent mode visuals across key UI surfaces.
- Added Open Graph metadata improvements for richer website sharing previews.

### Improved
- Improved workspace navigation with better active-workspace tracking and keyboard-driven pane interactions.
- Improved terminal scrollbar behavior, pane focus handling, and status bar/message input spacing.
- Improved project picker path display and general workspace UI polish.

### Fixed
- Fixed agent startup reliability by tightening PATH resolution and surfacing missing provider binaries in status.
- Fixed workspace route syncing, drag hit areas, and git diff panel header styling regressions.
- Fixed website mobile horizontal scrolling and ensured the workspace audio module builds during EAS installs.

## 0.1.28 - 2026-03-15

### Added
- Added OpenCode build and plan modes.
- Added website landing pages for Claude Code, Codex, and OpenCode.

### Improved
- Improved the git action menu for more reliable repository actions.
- Improved the mobile settings screen, workspace header actions, and welcome screen presentation.
- Updated the website hero copy and added a sponsor callout section.

### Fixed
- Fixed assistant file links so they open the correct workspace files from chat.

## 0.1.27 - 2026-03-13

### Added
- Added voice runtime with new audio engine architecture for voice interactions.
- Added Grep tool support in Claude tool-call mapping.
- Added ability to open workspace files directly from agent chat messages.
- Added desktop notifications via a custom native bridge.

### Improved
- Improved image picker, markdown rendering, and UI interactions.
- Improved shell environment detection using shell-env.

### Fixed
- Fixed platform-specific markdown link rendering.
- Fixed Linux AppImage CLI resource paths.
- Fixed Codex replacement stream being killed by stale turn notifications.

## 0.1.26 - 2026-03-12

### Added
- Added single-instance desktop behavior, Android APK download access, and refreshed splash screen styling.
- Added bundled Codex and OpenCode binaries in the server so setup no longer depends on global installs.
- Added Windows support with improved cross-platform shell execution.

### Improved
- Improved desktop runtime behavior on Windows by suppressing console windows and defaulting app data to `~/.paseo`.
- Added a Discord link to the website navigation.

### Fixed
- Fixed desktop Claude agent startup from the managed runtime and rotated logs correctly on restart.
- Fixed the home route to hide browser chrome when appropriate.
- Fixed Expo Metro compatibility by updating the `exclusionList` import.
- Fixed noisy shell output interfering with executable lookup.
- Fixed Windows resource-path handling by stripping the extended-length path prefix.

## 0.1.25 - 2026-03-11

### Fixed
- Fixed desktop app failing to start the built-in daemon on fresh macOS installs. The DMG was not notarized and code-signing stripped entitlements from the bundled Node runtime, causing Gatekeeper to block execution.
- Fixed Linux AppImage build by restoring the AppImage bundle format and stripping CUDA dependencies from onnxruntime.

## 0.1.24 - 2026-03-10

### Improved
- Improved command center keyboard navigation and new tab shortcut.
- Simplified desktop release pipeline for faster and more reliable builds.

## 0.1.21 - 2026-03-10
### Improved
- Improved desktop release reliability by fixing the Windows managed-runtime build path during GitHub Actions releases.

### Fixed
- Fixed a desktop release CI failure caused by a Unix-only server build script on Windows runners.
- Fixed server CI to build the relay dependency before running tests, restoring relay E2EE test coverage on clean runners.
- Fixed a Claude redesign test that depended on the local Claude CLI being installed.

## 0.1.20 - 2026-03-10
### Added
- Added workspace sidebar git actions with quick diff stats and archive controls.
- Added refreshed website downloads and homepage presentation for desktop installs.

### Improved
- Desktop release packaging now rebuilds and validates the bundled managed runtime during CI, improving installer reliability for macOS users.
- Improved desktop and web stream rendering, settings polish, and React 19.1.4 compatibility.

### Fixed
- Fixed Claude interrupt/restart regressions and strengthened managed-daemon smoke coverage for desktop releases.

## 0.1.19 - 2026-03-09
### Added
- Added a draft GitHub release flow so maintainers can upload and review desktop and Android release assets before publishing the final release.

## 0.1.18 - 2026-03-06
### Added
- Added a desktop `Mod+W` shortcut to close the current tab.

### Improved
- New and newly selected terminals now take focus automatically so you can type immediately.
- Kept newly created workspaces and projects in a more stable order in the sidebar.
- Improved project naming for GitHub remotes and expanded project icon discovery to Phoenix `priv/static` assets.
- Updated the website desktop download link to use the universal macOS DMG.

### Fixed
- Restored automatic agent metadata generation for Claude runs.

## 0.1.17 - 2026-03-06
### Added
- New workspace-first navigation model with workspace tabs, file tabs, and sortable tab groups.
- Keyboard shortcuts for workspace and tab navigation, with shortcut badges in the sidebar.
- Workspace-level archive actions with improved worktree archiving flow and context menu support.
- In-chat task notifications rendered as synthetic tool-call events for clearer status tracking.

### Improved
- Desktop builds now ship as a universal macOS binary (Apple Silicon + Intel).
- More reliable workspace routing and tab identity handling across refreshes and deep links.
- Better sidebar drag-and-drop behavior with explicit drag handles and nested list interactions.
- Smoother terminal/file rendering and WebGL-backed terminal performance improvements.
- Stronger provider error surfacing and updated Claude model/runtime handling.

### Fixed
- Fixed orphan workspace runs caused by non-canonical tab routes.
- Fixed mobile terminal tab remount/routing restore issues.
- Fixed agent metadata title/branch update reliability.
- Fixed stream/timeline ordering and cursor synchronization issues in the app.
- Fixed reversed edge-wheel scroll behavior in chat/tool stream views.

## 0.1.16 - 2026-02-22
### Added
- Update the Paseo desktop app and local daemon directly from Settings.
- Microphone and notification permission controls in Settings.
- Thinking/reasoning mode — agents can use extended thinking when the provider supports it.
- Autonomous run mode — let agents keep working without manual approval at each step.
- `paseo wait` now shows a snapshot of recent agent activity while you wait.

### Improved
- Smoother streaming with less UI flicker and scroll jumping during long agent runs.
- Faster agent sidebar list rendering.
- Archiving an agent now stops it first instead of archiving a half-running session.
- Agent titles no longer reset when refreshing.
- More reliable relay connections.

### Fixed
- Fixed Claude background tasks desyncing the chat.
- Fixed duplicate user messages appearing in the timeline.
- Fixed a startup crash caused by an OpenCode SDK update.
- Fixed spurious "needs attention" notifications from background agent activity.

## 0.1.15 - 2026-02-19
### Added
- Added a public changelog page on the website so users can browse release notes.

### Improved
- Redesigned the website get-started experience into a clearer two-step flow.
- Simplified website GitHub navigation and changelog headings.
- Improved app draft/new-agent UX with clearer working directory placeholder and empty-state messaging.
- Enabled drag interactions in previously unhandled areas on the desktop draft screen.
- Hid empty filter groups in the left sidebar.

### Fixed
- Fixed archived-agent navigation by redirecting archived agent routes to draft.
- Fixed duplicate `/rewind` user-message behavior.

## 0.1.14 - 2026-02-19
### Added
- Added Claude `/rewind` command support.
- Added slash command access in the draft agent composer.
- Added `@` workspace file autocomplete in chat prompts.
- Added support for pasting images directly into prompt attachments.
- Added optimistic image previews for pending user message attachments.
- Added shared desktop/web overlay scroll handles, including file preview panes.

### Improved
- Improved worktree flow after shipping, including better merged PR detection.
- Improved draft workflow by enabling the explorer sidebar immediately after CWD selection.
- Improved new worktree-agent defaults by prefilling CWD to the main repository.
- Improved desktop command autocomplete behavior to match combobox interactions.
- Improved git sync UX by simplifying sync labels and only showing Sync when a branch diverges from origin.
- Improved desktop settings and permissions UX on desktop.
- Improved scrollbar visibility, drag interactions, tracking, and animation timing on web/desktop.

### Fixed
- Fixed worktree archive/setup lifecycle issues, including terminal cleanup and archive timing.
- Fixed worktree path collisions by hashing CWD for collision-safe worktree roots.
- Fixed terminal sizing when switching back to an agent session.
- Fixed accidental terminal closure risk by adding confirmation for running shell commands.
- Fixed archive loading-state consistency across the sidebar and agent screen.
- Fixed autocomplete popover stability and workspace suggestion ranking.
- Fixed dictation timeouts caused by dangling non-final segments.
- Fixed server lock ownership when spawned as a child process by using parent PID ownership.
- Fixed hidden directory leakage in server CWD suggestions.
- Fixed agent attention notification payload consistency across providers.
- Fixed daemon version badge visibility in settings when daemon version data is unavailable.

## 0.1.9 - 2026-02-17
### Improved
- Unified structured-output generation through a single shared schema-validation and retry pipeline.
- Reused provider availability checks for structured generation fallback selection.
- Added structured generation waterfall ordering for internal metadata and git text generation: Claude Haiku, then Codex, then OpenCode.

### Fixed
- Fixed CLI `run --output-schema` to use the shared structured-output path instead of ad-hoc JSON parsing.
- Fixed `run --output-schema` failures where providers returned empty `lastMessage` by recovering from timeline assistant output.
- Fixed internal commit message, pull request text, and agent metadata generation to follow one consistent structured pipeline.

## 0.1.8 - 2026-02-17
### Added
- Added a cross-platform confirm dialog flow for daemon restarts.

### Improved
- Simplified local speech bootstrap and daemon startup locking behavior.
- Updated website hero copy to emphasize local execution.

### Fixed
- Fixed stuck "send while running" recovery across app and server session handling.
- Fixed Claude session identity preservation when reloading existing agents.
- Fixed combobox option behavior and related interactions.
- Fixed desktop file-drop listener cleanup to avoid uncaught unlisten errors.
- Fixed web tool-detail wheel event routing at scroll edges.

## 0.1.7 - 2026-02-16
### Added
- Improved agent workspace flows with better directory suggestions.
- Added iOS TestFlight and Android app access request forms on the website.

### Improved
- Unified daemon startup behavior between dev and CLI paths for more predictable local runs.
- Improved website app download and update guidance.

### Fixed
- Prevented an initial desktop combobox `0,0` position flash.
- Fixed CLI version output issues.
- Hardened server runtime loading for local speech dependencies.

## 0.1.6 - 2026-02-16
### Notes
- No major visible product changes in this patch release.

## 0.1.5 - 2026-02-16
### Added
- Added terminal reattach support and better worktree terminal handling.
- Added global keyboard shortcut help in the app.
- Added sidebar host filtering and improved agent workflow controls.

### Improved
- Improved worktree setup visibility by streaming setup progress.
- Improved terminal streaming reliability and lifecycle handling.
- Preserved explorer tab state so context survives navigation better.

## 0.1.4 - 2026-02-14
### Added
- Added voice capability status reporting in the client.
- Added background local speech model downloads with runtime gating.
- Added adaptive dictation finish timing based on server-provided budgets.
- Added relay reconnect behavior with grace periods and branch suggestions.

### Improved
- Improved connection selection and agent hydration reliability.
- Improved timeline loading with cursor-based fetch behavior.
- Improved first-run experience by bootstrapping a default localhost connection.
- Improved inline code rendering by auto-linkifying URLs.

### Fixed
- Fixed Linux checkout diff watch behavior to avoid recursive watches.
- Fixed stale relay client timer behavior.
- Fixed unnecessary git diff header auto-scroll on collapse.

## 0.1.3 - 2026-02-12
### Added
- Added CLI onboarding command.
- Added CLI `--output-schema` support for structured agent output.
- Added CLI agent metadata update support for names and labels.
- Added provider availability detection with normalization of legacy default model IDs.

### Improved
- Improved file explorer refresh feedback and unresolved checkout fallback handling.
- Added better voice interrupt handling with a speech-start grace period.
- Improved CLI defaults to list all non-archived agents by default.
- Improved website UX with clearer install CTA and privacy policy access.

### Fixed
- Fixed dev runner entry issues and sherpa TTS initialization behavior.

## 0.1.2 - 2026-02-11
### Notes
- No major visible product changes in this patch release.

## 0.1.1 - 2026-02-11

### Added
- Initial `0.1.x` release line.

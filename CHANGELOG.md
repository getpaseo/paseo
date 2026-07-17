# Changelog

## 0.2.0-beta.1 - 2026-07-17

### Added

- Work with pull requests and merge requests from GitLab, Gitea, Forgejo, and Codeberg ([#1913](https://github.com/getpaseo/paseo/pull/1913) by [@nllptrx](https://github.com/nllptrx))
- Use Oh My Pi as a native agent provider ([#2067](https://github.com/getpaseo/paseo/pull/2067) by [@ebg1223](https://github.com/ebg1223))
- Browse branch commit history and open individual commit diffs from Changes ([#1534](https://github.com/getpaseo/paseo/pull/1534), [#2146](https://github.com/getpaseo/paseo/pull/2146) by [@adradr](https://github.com/adradr))
- Open workspace files in more installed editors and file managers ([#2119](https://github.com/getpaseo/paseo/pull/2119))
- Remove individual custom providers from Settings ([#1951](https://github.com/getpaseo/paseo/pull/1951))

### Improved

- ACP provider catalog updated to the latest registry versions
- Workspace focus mode stays confined to the active workspace with a visible exit control ([#2151](https://github.com/getpaseo/paseo/pull/2151))
- Desktop installs the newest available update instead of a cached older release ([#2149](https://github.com/getpaseo/paseo/pull/2149))
- Remote daemon update failures now show specific recovery steps ([#2120](https://github.com/getpaseo/paseo/pull/2120))
- Agent history errors now appear immediately instead of after a timeout ([#2124](https://github.com/getpaseo/paseo/pull/2124))

### Fixed

- Terminal panes no longer remain at 80x24 after focus or visibility changes ([#2059](https://github.com/getpaseo/paseo/pull/2059), [#2154](https://github.com/getpaseo/paseo/pull/2154) by [@cleiter](https://github.com/cleiter))
- Sign-in popups in the desktop browser now complete successfully ([#2137](https://github.com/getpaseo/paseo/pull/2137))
- Browser typing and shortcuts no longer submit the active Paseo prompt ([#1982](https://github.com/getpaseo/paseo/pull/1982))
- Agent browser tabs remain controllable after switching workspaces ([#2156](https://github.com/getpaseo/paseo/pull/2156))
- Archived workspaces now show the correct Unarchive or Restore action ([#2002](https://github.com/getpaseo/paseo/pull/2002))
- Archived sessions can be reimported into the current workspace ([#2123](https://github.com/getpaseo/paseo/pull/2123))
- Browser shortcuts no longer appear where browser tabs are unavailable ([#2116](https://github.com/getpaseo/paseo/pull/2116) by [@jasonhnd](https://github.com/jasonhnd))

## 0.1.110 - 2026-07-16

### Fixed

- Kimi and other ACP agents now stay marked as running while a response is actively streaming ([#2148](https://github.com/getpaseo/paseo/pull/2148))

## 0.1.109 - 2026-07-16

> **Important update notice**
>
> If you installed Paseo Desktop 0.1.108, you need to [download and reinstall Paseo manually](https://paseo.sh/download) to get this fix. The bug in 0.1.108 prevents its automatic updater from installing 0.1.109. Users on 0.1.107 or earlier can update normally.

### Fixed

- Paseo Desktop no longer gets stuck connecting or loses native window controls after updating ([#2111](https://github.com/getpaseo/paseo/pull/2111) by [@cleiter](https://github.com/cleiter))

## 0.1.108 - 2026-07-16

### Added

- Create a new project folder or clone a GitHub repository from Add Project ([#1331](https://github.com/getpaseo/paseo/pull/1331), [#2045](https://github.com/getpaseo/paseo/pull/2045), [#2097](https://github.com/getpaseo/paseo/pull/2097) by [@mcowger](https://github.com/mcowger))
- Search for and open workspaces from the search menu ([#2096](https://github.com/getpaseo/paseo/pull/2096))
- Pin workspaces to the top of the sidebar ([#1981](https://github.com/getpaseo/paseo/pull/1981) by [@half144](https://github.com/half144))
- Summarize tool calls in a single collapsed item with a new appearance setting ([#2031](https://github.com/getpaseo/paseo/pull/2031), [#2069](https://github.com/getpaseo/paseo/pull/2069), [#2090](https://github.com/getpaseo/paseo/pull/2090) by [@mcowger](https://github.com/mcowger))
- Save browser cookies and site data across tabs and restarts ([#2089](https://github.com/getpaseo/paseo/pull/2089))
- Claude and Codex subagents now show their actual names, with a new option to archive finished Claude Code, Codex, and OpenCode subagents ([#2073](https://github.com/getpaseo/paseo/pull/2073))
- Fork chats from failed turns ([#2063](https://github.com/getpaseo/paseo/pull/2063))

### Improved

- Permission modes have clearer icons ([#1980](https://github.com/getpaseo/paseo/pull/1980) by [@cleiter](https://github.com/cleiter))
- Desktop stays usable in narrower windows ([#1983](https://github.com/getpaseo/paseo/pull/1983))
- Sidebar controls stay in place when desktop panels open and close ([#2078](https://github.com/getpaseo/paseo/pull/2078))
- Typing in long drafts is smoother ([#2086](https://github.com/getpaseo/paseo/pull/2086))
- Codex terminal commands always appear in chat, even when they have no output ([#2037](https://github.com/getpaseo/paseo/pull/2037))

### Fixed

- New Workspace keeps your prompt and attachments when you switch projects or hosts ([#2030](https://github.com/getpaseo/paseo/pull/2030), [#2036](https://github.com/getpaseo/paseo/pull/2036))
- OpenCode sessions close without crashing Paseo ([#2027](https://github.com/getpaseo/paseo/pull/2027) by [@mcowger](https://github.com/mcowger))
- Pi slash commands no longer leave chats stuck as running ([#2066](https://github.com/getpaseo/paseo/pull/2066) by [@ebg1223](https://github.com/ebg1223))
- Background-agent updates now appear after the main reply ([#2058](https://github.com/getpaseo/paseo/pull/2058) by [@1254087415](https://github.com/1254087415))
- Codex subagents no longer disappear from the Subagents track ([#2068](https://github.com/getpaseo/paseo/pull/2068))
- Forked chats open ready to edit in their new tab ([#2038](https://github.com/getpaseo/paseo/pull/2038))
- Paseo Desktop opens normally after an interrupted shutdown ([#1962](https://github.com/getpaseo/paseo/pull/1962))
- Keyboard shortcuts now work with `-`, `=`, `;`, and `'` ([#2047](https://github.com/getpaseo/paseo/pull/2047) by [@OnCloud125252](https://github.com/OnCloud125252))
- Codebuddy Code models now appear in the model picker ([#1979](https://github.com/getpaseo/paseo/pull/1979) by [@park0er](https://github.com/park0er))
- Workspace search now includes OpenCode commands and workflows ([#2049](https://github.com/getpaseo/paseo/pull/2049))
- Nix installations now include the Paseo web app ([#1978](https://github.com/getpaseo/paseo/pull/1978) by [@liamdiprose](https://github.com/liamdiprose))

## 0.1.107 - 2026-07-13

### Added

- Inspect provider-created subagents and their live conversations from the Subagents track ([#2013](https://github.com/getpaseo/paseo/pull/2013) by [@omercnet](https://github.com/omercnet))
- Fork chats with every supported agent provider ([#2022](https://github.com/getpaseo/paseo/pull/2022))

### Improved

- Add projects directly from New Workspace when none are configured ([#2026](https://github.com/getpaseo/paseo/pull/2026))
- New terminals open at the correct size immediately ([#2023](https://github.com/getpaseo/paseo/pull/2023) by [@cleiter](https://github.com/cleiter))
- Sidebar footer actions now explain themselves with tooltips ([#2025](https://github.com/getpaseo/paseo/pull/2025))
- Codex shell tool calls show only the command being run ([#2029](https://github.com/getpaseo/paseo/pull/2029))
- Custom ACP providers keep file and terminal work in the agent environment by default ([#2024](https://github.com/getpaseo/paseo/pull/2024))
- ACP provider catalog updated to the latest registry versions

### Fixed

- Large tables no longer make iOS chats unresponsive
- Chat controls remain clickable near the scroll-to-bottom button ([#2007](https://github.com/getpaseo/paseo/pull/2007))
- Oversized tool output no longer slows or floods chat timelines ([#2020](https://github.com/getpaseo/paseo/pull/2020))
- Cross-provider subagents can use providers without mode settings ([#2000](https://github.com/getpaseo/paseo/pull/2000) by [@githubbzxs](https://github.com/githubbzxs))
- Pi's internal metadata tasks no longer clutter normal session history ([#1999](https://github.com/getpaseo/paseo/pull/1999) by [@githubbzxs](https://github.com/githubbzxs))
- Pi chats remain usable after canceling extension commands ([#2019](https://github.com/getpaseo/paseo/pull/2019))

## 0.1.106 - 2026-07-12

### Added

- Approve Codex MCP permission requests in Paseo ([#2001](https://github.com/getpaseo/paseo/pull/2001))

### Improved

- ACP provider catalog updated to the latest registry versions

### Fixed

- Reduced mobile chat freezes and blank screens when switching workspaces while agents are streaming ([#1989](https://github.com/getpaseo/paseo/pull/1989))
- OpenCode sessions start reliably instead of occasionally losing the first turn ([#2015](https://github.com/getpaseo/paseo/pull/2015) by [@mcowger](https://github.com/mcowger))
- Switching between workspaces no longer flashes a white screen
- Pi keeps your existing MCP tools and settings when Paseo adds its own ([#1990](https://github.com/getpaseo/paseo/pull/1990) by [@mcowger](https://github.com/mcowger))

## 0.1.105 - 2026-07-10

### Added

- Browse changed files as a collapsible folder tree or flat list ([#1918](https://github.com/getpaseo/paseo/pull/1918), [#1945](https://github.com/getpaseo/paseo/pull/1945) by [@cleiter](https://github.com/cleiter))
- Always expand agent reasoning with a new appearance setting ([#1943](https://github.com/getpaseo/paseo/pull/1943) by [@mcowger](https://github.com/mcowger))

### Improved

- Project picker finds folders with fuzzy search and native desktop browsing ([#1968](https://github.com/getpaseo/paseo/pull/1968))
- Large workspace sidebars stay responsive ([#1966](https://github.com/getpaseo/paseo/pull/1966))
- Generated workspace names and Git text can use MiniMax M3 ([#1955](https://github.com/getpaseo/paseo/pull/1955) by [@octo-patch](https://github.com/octo-patch))
- Cursor now exposes thinking and fast mode ([#1952](https://github.com/getpaseo/paseo/pull/1952))

### Fixed

- Codex stays active and streams correctly while subagents run ([#1967](https://github.com/getpaseo/paseo/pull/1967))
- Android audio interruptions no longer crash voice mode or leave dictation stuck ([#1941](https://github.com/getpaseo/paseo/pull/1941))
- Mobile sidebars stay in sync and retain swipe-to-open gestures ([#1953](https://github.com/getpaseo/paseo/pull/1953), [#1976](https://github.com/getpaseo/paseo/pull/1976))
- Pi text-only models accept image prompts without breaking the session ([#1960](https://github.com/getpaseo/paseo/pull/1960))
- App render failures show a retryable recovery screen instead of a blank screen ([#1924](https://github.com/getpaseo/paseo/pull/1924))
- Pi context usage remains visible with older Oh My Pi versions ([#1886](https://github.com/getpaseo/paseo/pull/1886) by [@theslava](https://github.com/theslava))
- Provider usage popovers no longer error when opened and closed quickly ([#1885](https://github.com/getpaseo/paseo/pull/1885) by [@theslava](https://github.com/theslava))
- Mobile workspace menus hide desktop-only shortcut badges ([#1964](https://github.com/getpaseo/paseo/pull/1964))

## 0.1.104 - 2026-07-08

### Added

- Agents can drive the in-app browser with page snapshots, trusted input, dialogs, and tab controls ([#1881](https://github.com/getpaseo/paseo/pull/1881))
- Inspect, annotate, and send page elements from a browser tab to the agent ([#1708](https://github.com/getpaseo/paseo/pull/1708) by [@huiliaoning](https://github.com/huiliaoning))
- Schedules screen to create and manage recurring agents ([#1246](https://github.com/getpaseo/paseo/pull/1246))
- Open a project from anywhere with Cmd+O ([#1849](https://github.com/getpaseo/paseo/pull/1849))
- Agents can rename workspaces after they understand the task ([#1876](https://github.com/getpaseo/paseo/pull/1876))
- Claude Ultra Code is available for supported Claude models ([#1872](https://github.com/getpaseo/paseo/pull/1872))
- ByteDance TRAE CLI available as an agent provider ([#1831](https://github.com/getpaseo/paseo/pull/1831), [#1896](https://github.com/getpaseo/paseo/pull/1896) by [@park0er](https://github.com/park0er))

### Improved

- Manage the built-in daemon from one place in desktop settings ([#1938](https://github.com/getpaseo/paseo/pull/1938))
- Scheduled and loop runs each get their own workspace in the sidebar ([#1909](https://github.com/getpaseo/paseo/pull/1909), [#1934](https://github.com/getpaseo/paseo/pull/1934))
- Large provider and model refreshes load faster in the app ([#1895](https://github.com/getpaseo/paseo/pull/1895))
- Workspaces created by agents now get readable generated names ([#1887](https://github.com/getpaseo/paseo/pull/1887))
- Browser tabs opened by agents stay in the background until you switch to them ([#1875](https://github.com/getpaseo/paseo/pull/1875))
- Clearer cards when an agent asks a question ([#1643](https://github.com/getpaseo/paseo/pull/1643) by [@cleiter](https://github.com/cleiter))
- Diagnostic reports include desktop app logs ([#1914](https://github.com/getpaseo/paseo/pull/1914))
- Paseo's built-in tools take less context ([#1939](https://github.com/getpaseo/paseo/pull/1939))

### Fixed

- Renamed hosts keep their name after reconnecting ([#1940](https://github.com/getpaseo/paseo/pull/1940))
- Desktop finds your installed CLIs even when your shell is slow to start ([#1916](https://github.com/getpaseo/paseo/pull/1916))
- Restarting the daemon from desktop settings works reliably ([#1915](https://github.com/getpaseo/paseo/pull/1915))
- Restarting the daemon from the bundled CLI keeps it managed by the desktop app ([#1919](https://github.com/getpaseo/paseo/pull/1919))
- Web UI loads when the daemon is started from the bundled CLI ([#1899](https://github.com/getpaseo/paseo/pull/1899) by [@yzim](https://github.com/yzim))
- Worktree setup scripts keep your PATH ([#1908](https://github.com/getpaseo/paseo/pull/1908))
- Docker images keep running during provider cleanup and diagnostics ([#1877](https://github.com/getpaseo/paseo/pull/1877))
- New Workspace drafts survive archiving a workspace ([#1838](https://github.com/getpaseo/paseo/pull/1838))
- Composer autocomplete stays open after switching screens ([#1851](https://github.com/getpaseo/paseo/pull/1851))
- Claude usage appears when a quota window has no scheduled reset ([#1855](https://github.com/getpaseo/paseo/pull/1855))
- New workspace action shows for non-git projects in the sidebar ([#1857](https://github.com/getpaseo/paseo/pull/1857) by [@cleiter](https://github.com/cleiter))

## 0.1.103 - 2026-07-01

### Added

- Claude Sonnet 5 is available in the Claude model picker ([#1850](https://github.com/getpaseo/paseo/pull/1850))

## 0.1.102 - 2026-06-30

### Added

- Fork chats into a new tab or new worktree ([#1788](https://github.com/getpaseo/paseo/pull/1788))
- See workspaces from all connected hosts ([#1538](https://github.com/getpaseo/paseo/pull/1538), [#1775](https://github.com/getpaseo/paseo/pull/1775), [#1825](https://github.com/getpaseo/paseo/pull/1825))
- Daemon can now serve the web UI ([#1635](https://github.com/getpaseo/paseo/pull/1635), [#1739](https://github.com/getpaseo/paseo/pull/1739))
- Run Paseo from an official Docker image ([#1740](https://github.com/getpaseo/paseo/pull/1740) by [@Herbrant](https://github.com/Herbrant))
- Update a daemon remotely from the app ([#1513](https://github.com/getpaseo/paseo/pull/1513) by [@thedavidweng](https://github.com/thedavidweng))
- Configure separate OpenAI endpoints for speech-to-text and text-to-speech ([#1823](https://github.com/getpaseo/paseo/pull/1823))
- Drop files into any composer ([#1750](https://github.com/getpaseo/paseo/pull/1750), [#1801](https://github.com/getpaseo/paseo/pull/1801))
- Show MiniMax usage in quota views ([#1662](https://github.com/getpaseo/paseo/pull/1662) by [@ilteoood](https://github.com/ilteoood))
- Highlight C# code blocks ([#1651](https://github.com/getpaseo/paseo/pull/1651) by [@dev693](https://github.com/dev693))

### Improved

- New Workspace opens from anywhere ([#1746](https://github.com/getpaseo/paseo/pull/1746), [#1806](https://github.com/getpaseo/paseo/pull/1806))
- Project search shows loading progress ([#1762](https://github.com/getpaseo/paseo/pull/1762))
- Desktop update checks show clearer status ([#1808](https://github.com/getpaseo/paseo/pull/1808), [#1815](https://github.com/getpaseo/paseo/pull/1815))
- Slow remote hosts time out less aggressively ([#1789](https://github.com/getpaseo/paseo/pull/1789))
- Pi waits longer for extension results ([#1732](https://github.com/getpaseo/paseo/pull/1732) by [@theslava](https://github.com/theslava))
- Open file tabs refresh when you revisit them ([#1699](https://github.com/getpaseo/paseo/pull/1699) by [@cleiter](https://github.com/cleiter))
- Web terminals scroll more smoothly ([#1622](https://github.com/getpaseo/paseo/pull/1622) by [@TommyLike](https://github.com/TommyLike))

### Fixed

- Freshly added projects can be edited without restarting ([#1761](https://github.com/getpaseo/paseo/pull/1761) by [@huiliaoning](https://github.com/huiliaoning))
- Large repos open more reliably ([#1620](https://github.com/getpaseo/paseo/pull/1620) by [@jms830](https://github.com/jms830))
- Mobile restores the saved workspace on launch ([#1777](https://github.com/getpaseo/paseo/pull/1777))
- Agent prompts no longer rename workspaces ([#1779](https://github.com/getpaseo/paseo/pull/1779))
- Chat stays put when delayed history arrives ([#1776](https://github.com/getpaseo/paseo/pull/1776))
- Streamed chat images stay in order ([#1805](https://github.com/getpaseo/paseo/pull/1805))
- Chat actions stay below tool output ([#1827](https://github.com/getpaseo/paseo/pull/1827))
- Claude subagent narration stays out of chat ([#1807](https://github.com/getpaseo/paseo/pull/1807))
- Kiro slash commands and skills appear in Paseo ([#1792](https://github.com/getpaseo/paseo/pull/1792) by [@park0er](https://github.com/park0er))
- Agent lists survive stale project records ([#1812](https://github.com/getpaseo/paseo/pull/1812))
- Windows image previews handle drive-letter paths ([#1811](https://github.com/getpaseo/paseo/pull/1811))
- OpenCode closes cleanly on Windows ([#1771](https://github.com/getpaseo/paseo/pull/1771) by [@agamotto](https://github.com/agamotto))
- Desktop file uploads keep their extensions ([#1741](https://github.com/getpaseo/paseo/pull/1741))
- Claude Code cleanup kills child processes ([#1540](https://github.com/getpaseo/paseo/pull/1540) by [@TommyLike](https://github.com/TommyLike))
- OpenCode no longer indexes your home directory ([#1704](https://github.com/getpaseo/paseo/pull/1704) by [@rex-chang](https://github.com/rex-chang))
- Packaged macOS CLI daemon no longer shows extra Dock icons ([#1759](https://github.com/getpaseo/paseo/pull/1759) by [@yzim](https://github.com/yzim))
- `paseo daemon status` works without loading agents ([#1810](https://github.com/getpaseo/paseo/pull/1810))
- PR worktrees show pushed state correctly ([#1804](https://github.com/getpaseo/paseo/pull/1804))

## 0.1.101 - 2026-06-26

### Added

- Copy a troubleshooting report from Settings when support needs host, daemon, provider, and log details ([#1728](https://github.com/getpaseo/paseo/pull/1728))
- Claude image tool results now render as images in chat ([#1717](https://github.com/getpaseo/paseo/pull/1717))
- Added Japanese ([#1694](https://github.com/getpaseo/paseo/pull/1694) by [@sysCat64](https://github.com/sysCat64))
- Added Brazilian Portuguese ([#1653](https://github.com/getpaseo/paseo/pull/1653) by [@Alcimerio](https://github.com/Alcimerio))

### Improved

- Provider diagnostics stay useful even when model discovery is slow ([#1724](https://github.com/getpaseo/paseo/pull/1724))
- Slow provider requests no longer make the app look disconnected ([#1723](https://github.com/getpaseo/paseo/pull/1723))
- Worktrees linked to differently named tracked branches find their PRs correctly ([#1718](https://github.com/getpaseo/paseo/pull/1718))
- Workspaces started from slash-command prompts get clearer names ([#1709](https://github.com/getpaseo/paseo/pull/1709))
- ACP provider catalog updated to the latest registry versions

### Fixed

- Pi no longer creates empty sessions while loading new-agent options ([#1727](https://github.com/getpaseo/paseo/pull/1727))
- Windows daemon status finds the daemon process more reliably ([#1725](https://github.com/getpaseo/paseo/pull/1725))
- OpenAI voice credentials no longer affect other OpenAI-backed tools
- Provider model lists no longer disappear during refresh

## 0.1.100 - 2026-06-24

### Added

- Cycle agent modes with Shift+Tab
- Select a custom Copilot agent when starting or mid-session ([#1700](https://github.com/getpaseo/paseo/pull/1700))

### Improved

- ACP provider catalog updated to the latest registry versions

### Fixed

- Claude no longer sends an extra API request after each message ([#1701](https://github.com/getpaseo/paseo/pull/1701))
- OpenCode no longer leaves stray background servers running after sessions end ([#1697](https://github.com/getpaseo/paseo/pull/1697))
- Slash commands and skills now load in OMP agents ([#1698](https://github.com/getpaseo/paseo/pull/1698))

## 0.1.99 - 2026-06-23

### Improved

- The PR panel now has a refresh button and clearer loading states ([#1664](https://github.com/getpaseo/paseo/pull/1664))
- Provider diagnostics and model lists now stay in sync ([#1660](https://github.com/getpaseo/paseo/pull/1660))

### Fixed

- ACP providers like Grok no longer show duplicate user messages
- Saved composer modes no longer reset while provider data is loading ([#1658](https://github.com/getpaseo/paseo/pull/1658))
- The right sidebar no longer gets stuck on mobile ([#1661](https://github.com/getpaseo/paseo/pull/1661))

## 0.1.98 - 2026-06-21

### Added

- See plan usage in-app for Claude, Codex, Copilot, Cursor, Z.AI, Grok, and Kimi ([#1278](https://github.com/getpaseo/paseo/pull/1278) by [@ABorakati](https://github.com/ABorakati))
- Added Ultracode for Claude ([#1625](https://github.com/getpaseo/paseo/pull/1625))
- Detach a subagent to run it on its own ([#1612](https://github.com/getpaseo/paseo/pull/1612))
- Add a project without creating a workspace
- Add a setting to show branch names instead of titles in the sidebar

### Improved

- Mid-turn thinking and mode changes now say they apply next turn
- PR merge options name their method: squash, merge, or rebase ([#1608](https://github.com/getpaseo/paseo/pull/1608) by [@mcowger](https://github.com/mcowger))
- A running agent's mode change is remembered for new agents
- Copy a provider's launch diagnostic in one tap ([#1611](https://github.com/getpaseo/paseo/pull/1611))

### Fixed

- OpenCode no longer scans your whole disk on macOS desktop ([#1626](https://github.com/getpaseo/paseo/pull/1626))
- Daemon no longer crashes when OpenAI speech has no API key ([#1368](https://github.com/getpaseo/paseo/pull/1368) by [@mcowger](https://github.com/mcowger))
- Reopening an archived Codex agent no longer hangs
- Claude's context meter no longer jumps to subagent usage
- Claude's context meter fills from the first message in a new session
- OpenCode's mode picker now respects your disabled modes ([#1366](https://github.com/getpaseo/paseo/pull/1366) by [@mcowger](https://github.com/mcowger))
- File links and @-mentions find files in dot-folders and deep paths ([#1609](https://github.com/getpaseo/paseo/pull/1609))
- Archiving a project's last workspace no longer makes it vanish ([#1631](https://github.com/getpaseo/paseo/pull/1631))
- Collapsed sidebar projects stay collapsed

## 0.1.97 - 2026-06-18

### Added

- **Simplify workspace model** — run multiple workspaces on the same code without a worktree, each with its own agents, terminals, and status ([#1539](https://github.com/getpaseo/paseo/pull/1539))
- **Reopen archived workspaces from History** — restore a past workspace even after its worktree was removed
- **Terminals show when their agent is working, idle, or waiting for input** ([#1507](https://github.com/getpaseo/paseo/pull/1507))
- **Attach files to agents on mobile** ([#1501](https://github.com/getpaseo/paseo/pull/1501))
- **Hide dotfiles in the file explorer** ([#1516](https://github.com/getpaseo/paseo/pull/1516) by [@yuruiz](https://github.com/yuruiz))
- **Pin terminal, browser, and new-tab buttons to the tab row and sidebar**
- **Create a new workspace with a keyboard shortcut**

### Improved

- Workspace titles come from your first prompt and are shorter ([#1563](https://github.com/getpaseo/paseo/pull/1563))
- Copy a workspace's branch or path from its hover card
- Terminals stay smooth under heavy output ([#1500](https://github.com/getpaseo/paseo/pull/1500))
- Worktrees are removed when their last workspace is archived ([#1562](https://github.com/getpaseo/paseo/pull/1562))
- Finish notifications include subagent results ([#1558](https://github.com/getpaseo/paseo/pull/1558))
- Cursor lists only models you can select ([#1556](https://github.com/getpaseo/paseo/pull/1556))
- ACP provider catalog updated to the latest registry versions

### Fixed

- Brief daemon slowdowns no longer drop your connection
- Linux AppImage updates no longer hang on quit or delete the app ([#1485](https://github.com/getpaseo/paseo/pull/1485) by [@xpufx](https://github.com/xpufx))
- Opening Providers settings no longer crashes on Android ([#1537](https://github.com/getpaseo/paseo/pull/1537))
- Coding-agent terminal shortcuts work on Windows ([#1509](https://github.com/getpaseo/paseo/pull/1509))
- ACP and Kimi sessions can be imported again ([#1510](https://github.com/getpaseo/paseo/pull/1510) by [@wbxl2000](https://github.com/wbxl2000))
- ACP agents shut down without leaving orphaned processes ([#1460](https://github.com/getpaseo/paseo/pull/1460) by [@yeshan333](https://github.com/yeshan333))
- Imported session previews show clean prompts ([#1502](https://github.com/getpaseo/paseo/pull/1502))
- Local pairing offers use the correct app URL ([#1187](https://github.com/getpaseo/paseo/pull/1187) by [@aibaiiqpl](https://github.com/aibaiiqpl))
- The app no longer freezes from repeated provider re-probes
- Removing a project from the sidebar now removes the project itself instead of leaving it behind
- Workspace shortcut numbers no longer appear for the wrong key ([#1580](https://github.com/getpaseo/paseo/pull/1580) by [@cleiter](https://github.com/cleiter))
- Chats no longer hang when a message contains unmatched backticks ([#1585](https://github.com/getpaseo/paseo/pull/1585) by [@thaning0](https://github.com/thaning0))

## 0.1.96 - 2026-06-13

_This release only fixes an Android issue — desktop users don't need to update._

### Fixed

- On Android, the sidebar no longer reappears and gets stuck after you open a chat

## 0.1.95 - 2026-06-13

### Added

- **Attach any file to agents on desktop** ([#1474](https://github.com/getpaseo/paseo/pull/1474))

### Improved

- The git push button shows before merge actions when your branch is ahead ([#1488](https://github.com/getpaseo/paseo/pull/1488))
- SVG attachments are uploaded to disk
- Switching workspaces feels smoother

### Fixed

- Fixed cases where outdated GitHub data could be shown ([#1491](https://github.com/getpaseo/paseo/pull/1491))
- Uploaded images in PR comments and review threads now load in the PR panel ([#1486](https://github.com/getpaseo/paseo/pull/1486))
- Opening a project whose folder is missing shows a clear error ([#1490](https://github.com/getpaseo/paseo/pull/1490))
- The new workspace title moves out of the way of the keyboard ([#1489](https://github.com/getpaseo/paseo/pull/1489))
- Sidebars no longer open on their own on Android

## 0.1.94 - 2026-06-12

### Added

- **Attach pull request comments, reviews, threads, and failed check logs to chat from the PR panel** ([#1400](https://github.com/getpaseo/paseo/pull/1400))
- **Use Paseo in Arabic, Chinese, English, French, Russian, and Spanish** ([#1282](https://github.com/getpaseo/paseo/pull/1282), [#1478](https://github.com/getpaseo/paseo/pull/1478) by [@chyendongnhanh338](https://github.com/chyendongnhanh338), [@dwyanewang](https://github.com/dwyanewang))
- **Create reusable terminal profiles from Host settings**
- **Open workspaces in Antigravity** ([#1424](https://github.com/getpaseo/paseo/pull/1424) by [@krumpyzoid](https://github.com/krumpyzoid))

### Improved

- Claude skills appear in prompt autocomplete as you type ([#1464](https://github.com/getpaseo/paseo/pull/1464))
- Copy file paths directly from file preview tab menus ([#1473](https://github.com/getpaseo/paseo/pull/1473))
- PR status stays current after an agent merges a branch ([#1455](https://github.com/getpaseo/paseo/pull/1455))
- Workspace tabs stay fast by retaining only the active workspace screens ([#1472](https://github.com/getpaseo/paseo/pull/1472))

### Fixed

- Composer send shortcuts no longer conflict with other keyboard shortcuts
- Multi-question prompts advance one answer at a time ([#1462](https://github.com/getpaseo/paseo/pull/1462))
- Imported Pi sessions keep their original model and thinking settings ([#1441](https://github.com/getpaseo/paseo/pull/1441) by [@thomasaull](https://github.com/thomasaull))
- Reconnecting to a desktop host keeps the saved shell and workspace route
- Worktree terminals no longer appear in parent workspaces
- Mobile reconnects show the welcome screen correctly

## 0.1.93 - 2026-06-10

### Added

- **Claude Fable 5 is available in the Claude model picker** ([#1443](https://github.com/getpaseo/paseo/pull/1443) by [@0-Captain](https://github.com/0-Captain))

## 0.1.92 - 2026-06-10

### Added

- **Skills autocomplete inside prompts**

### Improved

- Provider catalog is inline in Host settings ([#1423](https://github.com/getpaseo/paseo/pull/1423))
- Manual update checks skip staged rollout delays
- CodeWhale replaces DeepSeek TUI in the provider catalog
- ACP provider catalog entries are updated for Cline, Codebuddy Code, DimCode, Factory Droid, Gemini, Nova, and Qoder
- OMP has its own icon and website page
- Model selector descriptions are clearer
- ACP provider errors show the provider's real failure message

### Fixed

- New Paseo worktree branches can push their first commits
- Imported sessions no longer open blank or in the wrong workspace
- Windows Explorer opens the selected workspace instead of Documents ([#1412](https://github.com/getpaseo/paseo/pull/1412) by [@bjspi](https://github.com/bjspi))
- Windows editor shortcuts installed as command shims launch correctly ([#1387](https://github.com/getpaseo/paseo/pull/1387) by [@Peter7896](https://github.com/Peter7896))
- ACP providers that cannot use MCP servers can start correctly
- Removed hosts no longer leave host pages stuck connecting
- File preview links open in your external browser
- Chat stays pinned to the latest message while output streams
- The mobile composer send button no longer shifts while typing

## 0.1.91 - 2026-06-08

### Added

- **Open multiple desktop windows** ([#1355](https://github.com/getpaseo/paseo/pull/1355) by [@arieel-ost](https://github.com/arieel-ost))
- **Open browser pop-ups and links inside workspace tabs** ([#1375](https://github.com/getpaseo/paseo/pull/1375))
- **Use the command center from mobile**
- **Add OMP as a provider** ([#1388](https://github.com/getpaseo/paseo/pull/1388))

### Improved

- New workspaces remember your last provider, mode, and thinking choices
- Git controls now default ready branches to pull requests and hide unavailable pull or push actions
- Desktop-managed hosts recover more reliably after stale daemon state
- Daemon status now explains authentication failures
- Project search skips Python virtual environments ([#1356](https://github.com/getpaseo/paseo/pull/1356))
- Config files can include `$schema` for editor help
- Claude MCP servers preserve always-load tool settings ([#1333](https://github.com/getpaseo/paseo/pull/1333) by [@nodomain](https://github.com/nodomain))
- Claude profiles keep their configured models ([#1311](https://github.com/getpaseo/paseo/pull/1311) by [@ilteoood](https://github.com/ilteoood))
- Provider loading can wait longer on slow machines ([#1346](https://github.com/getpaseo/paseo/pull/1346) by [@nodomain](https://github.com/nodomain))
- The Kimi catalog entry now points to Kimi Code CLI ([#1403](https://github.com/getpaseo/paseo/pull/1403) by [@wbxl2000](https://github.com/wbxl2000))
- ACP provider catalog entries are updated for Auggie, Claude Agent, Cline, Codebuddy Code, DimCode, Factory Droid, fast-agent, Gemini, GitHub Copilot, and Nova
- Local dictation crash reports show more useful details ([#1379](https://github.com/getpaseo/paseo/pull/1379))
- Daemon logs show why managed workers exit

### Fixed

- Pi compaction slash commands run correctly ([#1338](https://github.com/getpaseo/paseo/pull/1338) by [@chyendongnhanh338](https://github.com/chyendongnhanh338))
- Auto-archiving still works after a merged PR branch is deleted ([#1378](https://github.com/getpaseo/paseo/pull/1378))
- Worktrees can check out existing branch refs correctly ([#1358](https://github.com/getpaseo/paseo/pull/1358) by [@dixonl90](https://github.com/dixonl90))
- File downloads work when daemon password protection is enabled ([#1351](https://github.com/getpaseo/paseo/pull/1351) by [@nodomain](https://github.com/nodomain))
- iOS markdown links are tappable again ([#1334](https://github.com/getpaseo/paseo/pull/1334) by [@kaspesi](https://github.com/kaspesi))
- iOS markdown images render correctly
- Windows workspaces load their providers correctly ([#1329](https://github.com/getpaseo/paseo/pull/1329))
- Removing a localhost host stops its local daemon ([#1297](https://github.com/getpaseo/paseo/pull/1297) by [@mcowger](https://github.com/mcowger))
- Provider settings sheets stack correctly
- The new workspace screen no longer opens behind the mobile sidebar
- Global agent listing works again ([#1420](https://github.com/getpaseo/paseo/pull/1420))
- OpenCode compaction summaries stay out of chat
- OpenCode agents sharing a workspace keep their own Paseo tools

## 0.1.90 - 2026-06-04

### Added

- **Group the sidebar by status so workspaces waiting on you, ready to review, working, and done are visible at a glance** ([#1317](https://github.com/getpaseo/paseo/pull/1317))
- **Start a new workspace from the global sidebar button without choosing a project first** ([#1324](https://github.com/getpaseo/paseo/pull/1324))
- **Open the active file directly in your editor, file manager, or GitHub instead of only opening the workspace root** ([#1285](https://github.com/getpaseo/paseo/pull/1285) by [@aaronzhongg](https://github.com/aaronzhongg))
- **Automatically archive clean PR workspaces after the PR is merged from host settings** ([#1313](https://github.com/getpaseo/paseo/pull/1313))
- **Desktop-managed Paseo skills stay current after installing a newer desktop build** ([#1309](https://github.com/getpaseo/paseo/pull/1309))
- **Dart files and Dart code blocks are now syntax-highlighted** ([#1326](https://github.com/getpaseo/paseo/pull/1326))

### Improved

- Sidebar workspaces can be marked as read when they are ready to review or failed ([#1317](https://github.com/getpaseo/paseo/pull/1317))
- Child agents keep unattended permissions when delegated across providers ([#1315](https://github.com/getpaseo/paseo/pull/1315))
- Scheduled agents open with the real prompt and title instead of looking empty ([#1316](https://github.com/getpaseo/paseo/pull/1316))
- Git controls prioritize the action that gets a ready branch shipped ([#1316](https://github.com/getpaseo/paseo/pull/1316))
- Multiple agent questions are shown one at a time
- OpenCode questions with free-write answers show the typed response in Paseo
- Delegated agent activity is visible on the parent workspace
- Sessions are ordered by latest activity
- ACP provider catalog entries are updated for Claude Agent, Cline, Codebuddy Code, Factory Droid, and Qoder

### Fixed

- Timeline catch-up no longer leaves older messages unloaded
- Markdown code in file previews renders correctly
- Long dictation retries no longer stall new audio
- Settings host picker navigation works from host settings pages
- Diff gutter rows stay aligned with changed code
- Mobile sidebar gestures stay responsive under load
- Compact sheets keep their footer and bottom spacing visible

## 0.1.89 - 2026-06-02

### Added

- **Open workspace services through public service proxy links** ([#1280](https://github.com/getpaseo/paseo/pull/1280) by [@mcowger](https://github.com/mcowger))
- **Choose where new worktrees are created** ([#1230](https://github.com/getpaseo/paseo/pull/1230) by [@mcowger](https://github.com/mcowger))
- **Desktop windows reopen at the same size and position** ([#1224](https://github.com/getpaseo/paseo/pull/1224) by [@everton-dgn](https://github.com/everton-dgn))
- **Delegated agents can run independently and send recurring heartbeat updates**

### Improved

- Composer controls fit better in narrow panes
- Fork pull request badges stay visible in worktrees
- Cline in the ACP catalog is updated to v3

### Fixed

- Archiving a worktree finishes even if teardown hits an error ([#1260](https://github.com/getpaseo/paseo/pull/1260) by [@mcowger](https://github.com/mcowger))
- iOS chat messages render bold, italics, strikethrough, and line breaks correctly ([#1254](https://github.com/getpaseo/paseo/pull/1254) by [@outofrange-consulting](https://github.com/outofrange-consulting))
- Right-edge split pane resizing no longer clips ([#1261](https://github.com/getpaseo/paseo/pull/1261) by [@everton-dgn](https://github.com/everton-dgn))
- Pi extension command output no longer hangs
- Delegated agents no longer appear in workspace alert counts

## 0.1.88 - 2026-06-01

### Added

- **Choose an app theme from the new Appearance settings**
- **Set a custom interface font**
- **Set a custom code font**
- **Adjust the interface text size**
- **Adjust the code text size**
- **Choose a syntax highlighting theme**
- **Keep cron schedules aligned to a chosen time zone** ([#1232](https://github.com/getpaseo/paseo/pull/1232) by [@damselem](https://github.com/damselem))

### Improved

- Settings now has a flatter sidebar with a host picker
- Workspace tab switching is faster
- Compact composers now show context usage as a percentage
- Agent terminals opened in workspace subdirectories now appear with the rest of the workspace terminals
- macOS displays can idle normally while the desktop app is open ([#1242](https://github.com/getpaseo/paseo/pull/1242) by [@fireblue](https://github.com/fireblue))
- Large generated diffs now show a clear too-large placeholder instead of trying to render the whole file

### Fixed

- Chat history catches up correctly around long-running tool updates
- Terminal panes keep the right size after splitting or resizing panes
- Restored terminal snapshots reflow correctly after the pane size changes
- Workspace scripts menus keep the right size after launching a service
- iOS chat messages no longer hide inline links, URLs, or linked file paths ([#1257](https://github.com/getpaseo/paseo/pull/1257) by [@outofrange-consulting](https://github.com/outofrange-consulting))

## 0.1.87 - 2026-05-30

### Added

- Permission prompts from OpenCode subagents now surface in Paseo so you can approve or deny them

### Fixed

- Fixed an intermittent Android crash while animated views were drawing
- Fixed mobile bottom sheets not reopening after being dismissed

## 0.1.86 - 2026-05-29

### Added

- **Launch Grok (xAI) as a coding agent**
- **Fast mode for Claude Opus**
- **Multilingual local dictation with the new Parakeet v3 speech model**

### Improved

- Edit, Write, and Read tool calls are now syntax-highlighted
- The model selector shows the error when a provider fails to load
- The About page shows the versions of connected host daemons
- Refresh git diffs on demand with a new refresh button
- Previews can open readable files outside the current workspace
- Projects without an icon now show a colored icon instead of a grey placeholder
- Auto-generated agent titles and worktree branch names now use your configured provider fallbacks ([#1219](https://github.com/getpaseo/paseo/pull/1219) by [@mcowger](https://github.com/mcowger))
- Local dictation keeps its speech models out of the daemon, lowering its memory use

### Fixed

- On mobile, the whole composer now stays above the keyboard so the subagents track and draft pills no longer hide behind it
- The mobile agent timeline now catches up fully after reconnecting, so no messages go missing
- The slash command menu no longer shows /clear twice

## 0.1.85 - 2026-05-29

### Added

- **Opus 4.8 in the Claude model picker**, with a 1M-context variant

### Improved

- Archiving a worktree now keeps its agents under the archived list instead of removing them
- Archiving an agent cleans up any schedules targeting it

## 0.1.84 - 2026-05-28

### Added

- **Auto-accept tool calls for OpenCode agents**

### Improved

- Copy an OpenCode resume command to continue the session outside Paseo
- Model selector lists every enabled provider, with a Retry button when one fails to load
- Provider settings are easier to search and manage
- Other agents connecting to Paseo via MCP see the same providers, models, and modes as the app ([#1198](https://github.com/getpaseo/paseo/pull/1198))
- OpenCode Edit tool calls render as inline diffs
- Typing a slash command shows the best match first
- Daemon starts faster on workspaces with many git folders
- Markdown lists have tighter spacing
- Less jank when streaming agent responses
- User message footer controls align with the rest of the chat
- Agent mode controls use a cleaner monochrome treatment
- Compact layouts move the context ring to the footer right edge

### Fixed

- Allow selecting text in the chat on mobile ([#1153](https://github.com/getpaseo/paseo/pull/1153) by [@muzhi1991](https://github.com/muzhi1991))
- Submitting a Pi question no longer looks like a second prompt opened ([#1188](https://github.com/getpaseo/paseo/pull/1188) by [@yuruiz](https://github.com/yuruiz))
- Daemon memory leak from unbounded workspace git caches ([#1200](https://github.com/getpaseo/paseo/pull/1200))
- Provider diagnostics include the command override binary path ([#1191](https://github.com/getpaseo/paseo/pull/1191))
- OpenCode MCP servers connect correctly when the daemon binds to wildcard addresses
- Tool calls from MCP servers that return non-spec output no longer fail validation

## 0.1.83 - 2026-05-26

### Fixed

- Creating an agent via MCP now waits for it to actually start, so failures surface as a clear create error
- Scheduling an agent via MCP no longer rejects blank cadence placeholders
- Draft messages show the agent mode chip again on models without thinking options

## 0.1.82 - 2026-05-26

### Added

- **Rewind chat or files from any user message** ([#1154](https://github.com/getpaseo/paseo/pull/1154))
- **See the cumulative cost of an agent session** ([#1163](https://github.com/getpaseo/paseo/pull/1163))
- **Drop files onto the terminal to insert their paths** ([#1173](https://github.com/getpaseo/paseo/pull/1173))
- **Tap a file path in the terminal to open it in the workspace preview** ([#1174](https://github.com/getpaseo/paseo/pull/1174))
- **Approve OpenCode permissions for the whole session** ([#1168](https://github.com/getpaseo/paseo/pull/1168))
- **Workspace scripts now appear on the mobile header** ([#1093](https://github.com/getpaseo/paseo/pull/1093) by [@ayhanmalkoc](https://github.com/ayhanmalkoc))
- Devin CLI in the ACP provider catalog (by [@Alcimerio](https://github.com/Alcimerio))
- OpenCode agents show their mode colors

### Improved

- Mobile terminal keyboard hides when you open a sidebar
- Tool activity for read, write, and OpenCode tools renders more consistently ([#1171](https://github.com/getpaseo/paseo/pull/1171))
- Compact workspace header actions are tidier
- Settings latency readouts are easier to scan ([#1170](https://github.com/getpaseo/paseo/pull/1170))
- Pull request merge is available as soon as GitHub reports the PR is ready ([#1172](https://github.com/getpaseo/paseo/pull/1172))

### Fixed

- Mobile slash command autocomplete no longer flickers or mis-layers
- Interrupting an OpenCode agent returns it to idle instead of showing an error ([#1169](https://github.com/getpaseo/paseo/pull/1169))
- Provider model selection per workspace is honored ([#1167](https://github.com/getpaseo/paseo/pull/1167))
- Draft composer keeps the permission mode you selected ([#1175](https://github.com/getpaseo/paseo/pull/1175))
- Terminal color queries no longer return malformed replies
- File links in chat no longer crash when a message contains a bare '%' (by [@Elliotwu-7](https://github.com/Elliotwu-7))

## 0.1.81 - 2026-05-24

### Added

- **Paseo can now be installed as a web app from supported browsers** ([#1144](https://github.com/getpaseo/paseo/pull/1144))
- **Pi extension dialogs now appear as Paseo permission prompts** ([#1134](https://github.com/getpaseo/paseo/pull/1134) by [@yuruiz](https://github.com/yuruiz))
- Added community links and a home button to the sidebar

### Improved

- **Mobile terminals load faster and restore existing output more smoothly** ([#1147](https://github.com/getpaseo/paseo/pull/1147))
- Copying assistant messages preserves formatting
- Agent metadata fallback failures now log each provider attempt for easier debugging

### Fixed

- Android: slash command suggestions stay interactive when opened from the composer
- macOS: Alt+letter shortcuts work again
- Terminal panes no longer flicker during resize
- OpenCode MCP servers are injected once instead of being connected twice
- Import session no longer shows empty sessions
- Worktree archive status no longer reports false unpushed commits ([#1158](https://github.com/getpaseo/paseo/pull/1158))
- The `/exit`, `/quit`, and `/q` slash command aliases now show as one row
- Shortcut chord badges are readable in light mode
- Segmented controls show their track under every segment
- Sheet header search text is readable in dark mode

## 0.1.80 - 2026-05-21

### Fixed

- Opening dropdown menus no longer crashes on mobile

## 0.1.79 - 2026-05-21

### Added

- **Pi has been revamped with first-class support**
  - Runs through your installed Pi CLI, so your Pi extensions and configuration carry over
  - Pi agents can call Paseo tools when you have the Pi MCP extension installed
  - Import a Pi session you started in the terminal
  - Copy Pi's resume command from any agent to continue the session in your terminal
  - Windows: Pi sessions match correctly across symlinked and junctioned workspace paths
- **New home screen with quick tiles for adding a project, importing a session, setting up providers, and pairing a device**
- **Create an agent directly into a fresh worktree that auto-archives when the run finishes**
- **Set a custom system prompt that applies to every agent you start**
- **Rename workspaces, terminals, and agent tabs** ([#531](https://github.com/getpaseo/paseo/pull/531))
- **DeepSeek TUI in the ACP provider catalog** ([#1096](https://github.com/getpaseo/paseo/pull/1096))
- **Kiro CLI in the ACP provider catalog** (by [@huhusmang](https://github.com/huhusmang))
- Catalog providers show their icons in the model picker ([#1098](https://github.com/getpaseo/paseo/pull/1098))
- Custom environment variables passed when creating an agent now reach the agent process ([#1112](https://github.com/getpaseo/paseo/pull/1112))
- NixOS module supports the public TLS option for self-hosted relays ([#1106](https://github.com/getpaseo/paseo/pull/1106) by [@yzx9](https://github.com/yzx9))

### Improved

- **Stale host connections recover automatically without a manual refresh**
- Paseo opens to the workspace you were on last time you used it ([#1101](https://github.com/getpaseo/paseo/pull/1101))
- Workspaces remember which editor you opened them in
- Outdated daemons now suggest an upgrade when they receive a command they don't understand
- Voice mode is hidden while an agent is running
- Agent file-link tooltips show the full resolved file path ([#1088](https://github.com/getpaseo/paseo/pull/1088))
- Workspace git status refreshes less aggressively in the background ([#1102](https://github.com/getpaseo/paseo/pull/1102))

### Fixed

- macOS desktop no longer freezes after the display wakes from sleep ([#745](https://github.com/getpaseo/paseo/pull/745))
- Windows: Codex picks up the Microsoft Store install correctly ([#1020](https://github.com/getpaseo/paseo/pull/1020) by [@32r4](https://github.com/32r4))
- Workspace selection survives a daemon restart ([#1111](https://github.com/getpaseo/paseo/pull/1111))
- Cursor agents wait for slash commands to load before listing them ([#1099](https://github.com/getpaseo/paseo/pull/1099) by [@chrisbanes](https://github.com/chrisbanes))
- Codex sub-agents keep running through transient child process errors (by [@xy-plus](https://github.com/xy-plus))
- iPad terminals send Ctrl+C correctly from a hardware keyboard (by [@samatar26](https://github.com/samatar26))
- Git filenames with non-ASCII characters render correctly (by [@samatar26](https://github.com/samatar26))
- Paste shortcuts work on Dvorak keyboard layouts (by [@qin-nz](https://github.com/qin-nz))
- Claude file links resolve correctly for projects whose paths need SDK encoding
- Duplicate Claude result text no longer appears in chat ([#1095](https://github.com/getpaseo/paseo/pull/1095))
- Dynamic UI styles no longer leak CSS rules across the page ([#1103](https://github.com/getpaseo/paseo/pull/1103))
- Relay handshakes reject sessions that try to change encryption keys mid-flight ([#1037](https://github.com/getpaseo/paseo/pull/1037) by [@joaosa](https://github.com/joaosa))

## 0.1.78 - 2026-05-18

### Improved

- **Mobile model selector is faster and more straightforward** Picking a model, mode, or thinking option takes fewer taps

### Fixed

- Splitting a pane no longer loses your scroll position
- Typing in mobile sheets no longer flickers
- Sheets on mobile web no longer crash when swiped to dismiss

## 0.1.77 - 2026-05-18

### Added

- **Slash commands to end and restart an agent**
- **Syntax highlighting for code blocks in chat**
- **Copy button on code blocks in chat**
- **Configurable terminal scrollback** ([#1021](https://github.com/getpaseo/paseo/pull/1021) by [@32r4](https://github.com/32r4))
- Assistant file links open at a specific line range when one is included
- Mode icons appear in the agent status menu ([#1059](https://github.com/getpaseo/paseo/pull/1059) by [@32r4](https://github.com/32r4))
- MCP exposes schedule update, logs, and run-once tools ([#1032](https://github.com/getpaseo/paseo/pull/1032) by [@skevetter](https://github.com/skevetter))
- Self-hosted relays can use a different TLS setting for the public endpoint ([#1045](https://github.com/getpaseo/paseo/pull/1045) by [@yzx9](https://github.com/yzx9))

### Improved

- User messages now have a distinct bubble fill for clearer chat hierarchy
- Closing a tab returns to its parent tab
- Diff rows show the full file path on hover ([#1061](https://github.com/getpaseo/paseo/pull/1061) by [@Myriad-Dreamin](https://github.com/Myriad-Dreamin))
- The CLI shows the remote daemon host when `ls` cannot connect ([#1043](https://github.com/getpaseo/paseo/pull/1043) by [@mturac](https://github.com/mturac))
- Nix install of the daemon is smaller ([#966](https://github.com/getpaseo/paseo/pull/966) by [@ixxie](https://github.com/ixxie))
- Nix install honors home-manager profile paths when inheriting the user PATH ([#1040](https://github.com/getpaseo/paseo/pull/1040) by [@ixxie](https://github.com/ixxie))

### Fixed

- OpenCode probes no longer create empty sessions
- OpenCode custom commands no longer hang
- OpenCode session imports succeed across more environments
- Native diff rows expand correctly ([#940](https://github.com/getpaseo/paseo/pull/940) by [@bolasblack](https://github.com/bolasblack))
- Mobile sidebar interactions work correctly on web ([#900](https://github.com/getpaseo/paseo/pull/900) by [@nikuscs](https://github.com/nikuscs))
- Mobile web drag gestures fire reliably ([#1048](https://github.com/getpaseo/paseo/pull/1048) by [@nikuscs](https://github.com/nikuscs))
- Mobile web drag-and-drop activates correctly ([#1048](https://github.com/getpaseo/paseo/pull/1048) by [@nikuscs](https://github.com/nikuscs))
- iOS Safari no longer zooms when focusing the composer ([#1048](https://github.com/getpaseo/paseo/pull/1048) by [@nikuscs](https://github.com/nikuscs))
- Enter behavior in the mobile web composer is consistent ([#1048](https://github.com/getpaseo/paseo/pull/1048) by [@nikuscs](https://github.com/nikuscs))
- Composer no longer flickers when resizing with long prompts
- Inline code links in assistant messages open the correct file
- Host switcher popover is wide enough to show host names ([#981](https://github.com/getpaseo/paseo/pull/981) by [@kongjiadongyuan](https://github.com/kongjiadongyuan))
- Windows: importing existing sessions matches paths correctly ([#1012](https://github.com/getpaseo/paseo/pull/1012) by [@kj1534](https://github.com/kj1534))

## 0.1.76 - 2026-05-15

### Added

- **Chat timestamps and turn durations** Every message shows when it was sent, and each turn surfaces how long the agent took
- **Auto Review permission mode for Claude Code and Codex** Agents stop after each assistant turn for review instead of running unattended ([#928](https://github.com/getpaseo/paseo/pull/928), [#963](https://github.com/getpaseo/paseo/pull/963) by [@bolasblack](https://github.com/bolasblack))
- Surface Codex's context compaction events and the `/compact` command in chat
- Optional auto-archive for worktrees once their PR merges
- Paste a GitHub PR or issue URL into the composer to attach it as context
- Surface GitHub auto-merge actions in the PR hover card
- Show all PR check counts in the PR hover card
- Rename a project to disambiguate duplicates that share a folder name
- Confirm before archiving a worktree with uncommitted or unpushed work
- Claude Code now picks up models from `~/.claude/settings.json` so custom model lists show up in the model picker
- Local Claude Code settings (`.claude/settings.local.json`) apply per workspace
- Diagnostics for generic ACP providers surface in the model picker
- Allow setting fast mode for Paseo subagents ([#909](https://github.com/getpaseo/paseo/pull/909), [#910](https://github.com/getpaseo/paseo/pull/910) by [@kongjiadongyuan](https://github.com/kongjiadongyuan))

### Improved

- Surface Claude error messages in chat instead of ending the turn silently
- Workspace checkout picker auto-selects when a single PR is attached
- New workspace flow honors the currently checked-out branch when branching off ([#909](https://github.com/getpaseo/paseo/pull/908) by [@sbtobb](https://github.com/sbtobb))
- OpenCode models from console subscription providers now appear in the model picker ([#917](https://github.com/getpaseo/paseo/pull/917) by [@t2o2](https://github.com/t2o2))
- Cursor model picker reflects the models advertised by the Cursor ACP client ([#958](https://github.com/getpaseo/paseo/pull/958) by [@chrisbanes](https://github.com/chrisbanes))

### Fixed

- iPad hardware Enter submits the composer ([#919](https://github.com/getpaseo/paseo/pull/919) by [@kongjiadongyuan](https://github.com/kongjiadongyuan))
- PR status falls back to a non-checks query for fine-grained GitHub tokens ([#932](https://github.com/getpaseo/paseo/pull/932) by [@32r4](https://github.com/32r4))
- ACP errors display as readable text instead of `[object Object]`
- OpenCode no longer hangs on retry when the upstream provider stalls
- Worktree ahead count is correct when the upstream branch has been deleted
- Branch-off worktrees track the correct upstream
- File changes view works on empty repositories with no commits yet
- Assistant message file links open the correct file
- Default thinking option matches the selected model's capabilities
- Shift+Enter works again in terminal input modes
- Duplicate project entries no longer appear after reopening a project
- Pi-backed sessions recover after a Copilot 413 instead of staying stuck
- Skip probing unrelated executable candidates when launching agents
- Relay E2EE reconnects cleanly under racing connect/disconnect
- Workspace kind stays in sync with project kind after reconfiguration
- zsh integration files install with usable runtime modes
- MCP worktree cache refreshes after create and archive ([#911](https://github.com/getpaseo/paseo/pull/911) by [@kongjiadongyuan](https://github.com/kongjiadongyuan))

## 0.1.75 - 2026-05-12

### Added

- Set the speech-to-text language used by dictation and voice mode from settings ([#941](https://github.com/getpaseo/paseo/pull/941))

### Fixed

- Codex resume failures now surface as explicit errors instead of leaving the agent silently stuck ([#947](https://github.com/getpaseo/paseo/pull/947))
- Custom providers extending Codex now route correctly when they set a custom `OPENAI_BASE_URL` ([#915](https://github.com/getpaseo/paseo/pull/915))
- Fixed Copilot's **Allow All** mode (renamed from Autopilot) ([#935](https://github.com/getpaseo/paseo/pull/935))
- Desktop: daemon startup no longer fails when a stale PID file is left next to a still-running daemon ([#913](https://github.com/getpaseo/paseo/pull/913) by [@biaoma-ty](https://github.com/biaoma-ty))
- iPhone HEIC photos now attach correctly from the image picker ([#934](https://github.com/getpaseo/paseo/pull/934))
- Scheduled agents now archive automatically after each run ([#945](https://github.com/getpaseo/paseo/pull/945))
- Windows: Codex command summaries trim `pwsh`, `powershell`, or `cmd` wrappers ([#931](https://github.com/getpaseo/paseo/pull/931) by [@32r4](https://github.com/32r4))
- iPad: settings sidebar and main sidebar respect the top safe area in wide layouts ([#922](https://github.com/getpaseo/paseo/pull/922), [#937](https://github.com/getpaseo/paseo/pull/937) by [@kongjiadongyuan](https://github.com/kongjiadongyuan))

## 0.1.74 - 2026-05-11

### Fixed

- **OpenCode agent turns no longer stall** Paseo now follows OpenCode's global event stream, so turns stream reliably without falling back to fragile recovery paths ([#916](https://github.com/getpaseo/paseo/pull/916))

## 0.1.73 - 2026-05-10

### Fixed

- **OpenCode agents work again on OpenCode 1.14.42+** ([#895](https://github.com/getpaseo/paseo/pull/895), [#902](https://github.com/getpaseo/paseo/pull/902), [#904](https://github.com/getpaseo/paseo/pull/904) by [@atomlink-ye](https://github.com/atomlink-ye), [@plutofog](https://github.com/plutofog))
- Web: opening a workspace no longer hangs in browsers without `crypto.randomUUID` ([#858](https://github.com/getpaseo/paseo/pull/858) by [@cokekitten](https://github.com/cokekitten))
- Codex sub-agent child tool calls now report a final failure state instead of staying as "running" ([#899](https://github.com/getpaseo/paseo/pull/899))
- Old relay pairing URLs without an explicit TLS flag work again ([#896](https://github.com/getpaseo/paseo/pull/896))
- macOS: the tab-jump shortcut no longer collides with system shortcuts ([#859](https://github.com/getpaseo/paseo/pull/859) by [@nikuscs](https://github.com/nikuscs))
- Web: the composer no longer triggers a bottom-sheet keyboard on desktop browsers ([#898](https://github.com/getpaseo/paseo/pull/898) by [@nikuscs](https://github.com/nikuscs))
- Windows: git operations no longer flash a console window on each invocation ([#897](https://github.com/getpaseo/paseo/pull/897))
- File explorer no longer follows symlinks outside the workspace root ([#847](https://github.com/getpaseo/paseo/pull/847) by [@joaosa](https://github.com/joaosa))
- Desktop only opens external URLs via http(s) and mailto schemes ([#845](https://github.com/getpaseo/paseo/pull/845) by [@joaosa](https://github.com/joaosa))
- MCP debug request logs now redact request bodies ([#842](https://github.com/getpaseo/paseo/pull/842) by [@joaosa](https://github.com/joaosa))

## 0.1.72 - 2026-05-10

### Fixed

- **Codex approval prompts no longer hang** Fixes a regression introduced in 0.1.70 where Codex agents would wait forever on command and file approvals — the prompt never reached the app and the agent stayed stuck in "running" ([#866](https://github.com/getpaseo/paseo/pull/866), [#869](https://github.com/getpaseo/paseo/pull/869))
- **Windows: daemon no longer crashes when Codex emits non-JSON output** Localized stdout lines from the Codex CLI are now ignored instead of taking down the daemon worker ([#866](https://github.com/getpaseo/paseo/pull/866))
- Drag-and-drop images onto the new workspace screen now works ([#850](https://github.com/getpaseo/paseo/pull/850))
- Archiving a worktree from the toolbar redirects you immediately instead of leaving you on the dead screen for a beat ([#852](https://github.com/getpaseo/paseo/pull/852))
- Pi-backed sessions now shut down cleanly when you close them, releasing extension resources on the Pi side ([#863](https://github.com/getpaseo/paseo/pull/863))

## 0.1.71 - 2026-05-09

### Added

- **Import existing Claude, Codex, and OpenCode sessions** into Paseo — pick up a conversation you started in the terminal and keep going from the app, with the full timeline ([#766](https://github.com/getpaseo/paseo/pull/766), [#833](https://github.com/getpaseo/paseo/pull/833))
- **Subagents now appear in a collapsible section above the composer** so you can jump into agents your main agent spawned ([#532](https://github.com/getpaseo/paseo/pull/532))
- Merge a pull request directly from the checkout pane ([#814](https://github.com/getpaseo/paseo/pull/814))
- Customize the per-project prompts Paseo uses to auto-generate agent titles, branch names, commit messages, and pull request descriptions ([#836](https://github.com/getpaseo/paseo/pull/836))
- Open an empty workspace without typing a prompt first ([#834](https://github.com/getpaseo/paseo/pull/834))
- Project settings are now grouped with inline links to the relevant docs ([#837](https://github.com/getpaseo/paseo/pull/837))
- Rich context menu on desktop — copy link, copy image, and spellcheck suggestions
- Archiving a Codex-backed agent now archives the underlying native Codex thread too ([#827](https://github.com/getpaseo/paseo/pull/827) by [@32r4](https://github.com/32r4))

### Improved

- Opening a workspace auto-focuses the agent that needs your attention ([#828](https://github.com/getpaseo/paseo/pull/828))
- An unattended agent that spawns a sub-agent on a different provider via MCP now starts the sub-agent in unattended mode too

### Fixed

- iOS project picker now submits the typed path ([#831](https://github.com/getpaseo/paseo/pull/831))
- System messages and chat mentions routed to multiple agents now reach every recipient consistently ([#830](https://github.com/getpaseo/paseo/pull/830))
- Clicking a Markdown link in agent output no longer reloads the desktop app on top of opening the link
- macOS desktop tab-jump shortcuts now use Cmd+Option+1-9, avoiding conflicts with Option-based international keyboard characters such as `@`

### Security

- Local state files (daemon keypair, stored credentials, persisted config) are now readable only by the owning user ([#825](https://github.com/getpaseo/paseo/pull/825) by [@joaosa](https://github.com/joaosa))

## 0.1.70 - 2026-05-08

### Breaking

- **Claude agents now require `claude` on your PATH** Install Claude Code globally (`npm install -g @anthropic-ai/claude-code`) before running a Claude agent — Paseo no longer ships a bundled fallback binary. Same posture as Codex and OpenCode, and shrinks the desktop install by ~210 MB per platform

### Added

- **One-click ACP providers** — add Cursor, Hermes, Qwen Coder, Kimi Code, and other ACP agents from a built-in catalog instead of writing config by hand
- Codex `/goal` slash command — set or update the goal mid-turn while a Codex agent is running
- Claude's Sonnet 4.6 1M context model is now selectable in the model picker
- Detect GitHub issue and PR URLs pasted into the composer search
- `paseo worktree create` CLI command, with parity to the MCP `create_worktree` tool
- `paseo schedule update` to edit a schedule in place without recreating it
- `paseo schedule run-once` for cron-style triggers, plus `--mode` on `schedule` and `loop`. Background runs now default to unattended mode
- Projects settings now lists workspaces from any remote — GitLab, Gitea, Bitbucket, self-hosted, and SSH-style URLs, not just GitHub ([#681](https://github.com/getpaseo/paseo/pull/681) by [@krumpyzoid](https://github.com/krumpyzoid))

### Improved

- Skills now install, update, and uninstall on demand instead of silently auto-syncing on every desktop launch
- Self-hosted relays can opt into `wss://` for TLS connections
- Workspace open targets only show options reachable from the current daemon
- Combobox search matches model descriptions, not just names
- Codex image attachments render inline as path markdown
- Subagent task notifications no longer clutter the parent agent's timeline
- Voice mode: quieter thinking tone and small UI polish
- Settings sidebar order: Projects now appears after General
- Electron upgraded to 41.2.0 for the desktop app

### Fixed

- **Claude agent: daemon no longer crashes mid-turn** when the underlying SDK fires a stray control message after the connection has been torn down
- **Windows:** Terminals start reliably and shut down cleanly without leaving stuck processes behind
- **Linux:** Workspace file watchers no longer storm with events on busy working trees, fixing CPU spikes on large repos ([#794](https://github.com/getpaseo/paseo/pull/794) by [@312223105](https://github.com/312223105))
- ACP-based agents launch terminal shell commands reliably ([#793](https://github.com/getpaseo/paseo/pull/793) by [@ebg1223](https://github.com/ebg1223))
- Checkout shortstat now counts untracked files ([#608](https://github.com/getpaseo/paseo/issues/608), [#762](https://github.com/getpaseo/paseo/pull/762) by [@somus](https://github.com/somus))
- Relay endpoints on port 443 use TLS automatically ([#774](https://github.com/getpaseo/paseo/pull/774) by [@caoer](https://github.com/caoer))
- Desktop CLI passthrough TTY handling — interactive commands now behave correctly when launched from the desktop app
- The CLI honors the `PASEO_PASSWORD` environment variable for password-protected daemons
- Daemon shutdown terminates all child processes cleanly using tree-kill
- Agent spawn paths handle missing executables and unusual install layouts more reliably
- OpenCode now forwards provider retry errors instead of silently swallowing them
- Codex import no longer reverts to the wrong default mode
- Pane keyboard shortcuts no longer fire while you're typing in an editable field
- Cold workspace URL navigation now lands in the correct sidebar entry on web
- Workspace navigation regression on web fixed
- Duplicate workspace shell navigation eliminated
- The 'Update installed' callout no longer flashes incorrectly
- Browser pane reload focus and devtools handling
- MCP terminal capture now includes scrollback
- Worktree branches no longer get renamed when an agent is created against an existing worktree from MCP
- Creating an agent in a subdirectory of a registered workspace now runs in that subdirectory instead of jumping up to the parent ([#551](https://github.com/getpaseo/paseo/issues/551))
- Non-GitHub project display names are derived from the remote owner/repo instead of the local path
- Desktop IPC wrapped in shared mutation/query hooks, fixing stale state and intermittent failures ([#761](https://github.com/getpaseo/paseo/issues/761))
- `paseo schedule create --host` now requires `--cwd` to avoid running schedules in the wrong directory
- `paseo schedule create --every` runs once immediately by default, then on the configured interval
- MCP `create_agent` validates the requested mode and refuses silent cross-provider inheritance

## 0.1.69 - 2026-05-05

### Fixed

- Paseo now recovers automatically when an internal daemon process crashes — your agents stay connected instead of getting stuck and you don't have to restart anything
- Answering an interactive question from a Claude agent now reaches Claude correctly instead of being dropped ([#760](https://github.com/getpaseo/paseo/pull/760) by [@somus](https://github.com/somus))

## 0.1.68 - 2026-05-05

### Fixed

- The desktop app no longer fails on first launch after a fresh install

## 0.1.67 - 2026-05-03

### Fixed

- Archiving a worktree or workspace feels instant instead of waiting on the daemon, with automatic rollback if it fails
- The built-in daemon toggle in desktop settings now actually takes effect
- Desktop settings no longer reset on app launch after a legacy migration
- Desktop daemon startup failures now surface on the splash screen and respond to retry, instead of leaving the app silently stuck
- Internal LLM calls (branch names, commit messages, PR text) no longer leave behind ephemeral agent sessions in your provider history

## 0.1.66 - 2026-05-03

### Fixed

- Streaming markdown preserves trailing newlines so paragraph spacing stays correct while the agent is still typing
- Agent initialization failures surface within 30 seconds instead of 5 minutes
- Terminals reply to ANSI cursor-position queries, so tools that ask for cursor location no longer hang

## 0.1.65 - 2026-05-03

### Added

- **In-app browser** — open a real web browser in any workspace to test your app ([#670](https://github.com/getpaseo/paseo/pull/670) by [@jasonkneen](https://github.com/jasonkneen))
- Inline review comments in the git diff pane. Tap a line number to start a comment ([#530](https://github.com/getpaseo/paseo/pull/530))
- Sub-agent activity is now shown for Codex, OpenCode, and Claude ([#672](https://github.com/getpaseo/paseo/pull/672), [#658](https://github.com/getpaseo/paseo/pull/658) by [@thisisryanswift](https://github.com/thisisryanswift))
- Pull and push your branch in one step from the git actions menu in the changes pane
- Resume existing agent sessions with `paseo import --provider <name> <id>` ([#632](https://github.com/getpaseo/paseo/pull/632))
- Password authentication and SSL support for daemon connections ([#635](https://github.com/getpaseo/paseo/pull/635))
- Connect to a daemon via relay using a pairing offer URL from the CLI ([#639](https://github.com/getpaseo/paseo/pull/639))
- **Windows:** Native ARM64 builds are now available
- Bundled Paseo skills now refresh automatically on desktop app launch

### Improved

- Codex streaming feels more responsive — message boundaries are preserved and output arrives sooner
- Terminal sessions run in a dedicated worker process for better stability
- New worktree branch names are derived from your prompt and attachments instead of a generic placeholder
- Review comment UI is cleaner and easier to scan
- The daemon's `/api/status` endpoint is now protected by password auth when one is configured

### Fixed

- **Apple Silicon Mac:** The desktop update pipeline now publishes manifests atomically, closing a race that could install the Intel build on Apple Silicon Macs and cause 100%+ renderer CPU usage. Affected users will self-heal — electron-updater's Rosetta detection migrates back to arm64 on the next update poll ([#555](https://github.com/getpaseo/paseo/issues/555))
- **Linux:** `.deb` and `.rpm` packages now show as `Paseo` in the dock and process list instead of `Paseo.bin`. `--no-sandbox` is now scoped to AppImage only, matching VS Code's sandbox handling ([#602](https://github.com/getpaseo/paseo/issues/602))
- **Windows:** Git diff commands no longer break on paths with special characters ([#629](https://github.com/getpaseo/paseo/pull/629))
- Cursor CLI and other ACP custom providers launch reliably ([#628](https://github.com/getpaseo/paseo/pull/628))
- Daemon stays up when WebSocket clients disconnect mid-stream, and crashes now write a fatal log entry instead of disappearing silently ([#613](https://github.com/getpaseo/paseo/pull/613) by [@yuruiz](https://github.com/yuruiz))
- Long agent timelines reconnect cleanly over the relay instead of looping through disconnects while catching up ([#657](https://github.com/getpaseo/paseo/pull/657) by [@fireblue](https://github.com/fireblue))
- Agent timelines refresh with smaller catch-up requests when you reopen an agent
- Terminal snapshots flush reliably before clients reconnect
- Workspace reconnects avoid unnecessary refresh work when the focused workspace is already current
- Voice dictation keeps recording when the agent tab loses focus
- OpenCode mode picker now lists agents available in every mode ([#606](https://github.com/getpaseo/paseo/pull/606) by [@thisisryanswift](https://github.com/thisisryanswift))
- Codex plan approval panels no longer duplicate
- Imported agents display the correct title immediately
- OpenCode surfaces invalid mode/model errors instead of hanging
- Archived worktrees stay hidden without flashing back into the list ([#640](https://github.com/getpaseo/paseo/pull/640))
- Web dropdown menus no longer resize unexpectedly
- The visible changes pane keeps in sync with the working tree diff
- Tool detail rows on the timeline are selectable again
- `paseo.json` parse errors in setup, teardown, and terminal actions now surface a clear error instead of failing silently
- Diff gutter line numbers were shifted one row out of alignment in some cases on web
- Streamed agent output reconciles cleanly when the timeline hydrates mid-turn ([#663](https://github.com/getpaseo/paseo/pull/663))
- Images in assistant messages show a loading spinner while they load and an "Image unavailable" fallback if they fail, instead of a blank space
- Isolated bottom sheet modals close and re-open without getting stuck

## 0.1.64 - 2026-04-28

### Added

- OpenCode now has a Full Access mode that auto-approves tool calls ([#595](https://github.com/getpaseo/paseo/pull/595) by [@tmih06](https://github.com/tmih06))
- OpenCode supports executable slash commands ([#597](https://github.com/getpaseo/paseo/pull/597) by [@tmih06](https://github.com/tmih06))

### Improved

- `@`-mention stays responsive on very large projects ([#600](https://github.com/getpaseo/paseo/pull/600) by [@yuruiz](https://github.com/yuruiz))

### Fixed

- Workspaces still load when `paseo.json` has a parse error

## 0.1.63 - 2026-04-28

### Added

- Project settings page with a built-in `paseo.json` editor
- Cold start restores your last open workspace
- Tool call badges have a button to open the referenced file directly
- Open the current branch on GitHub from a workspace's open menu ([#583](https://github.com/getpaseo/paseo/pull/583) by [@Myriad-Dreamin](https://github.com/Myriad-Dreamin))
- Enable or disable providers from Settings without editing config files
- Paseo prompts you to configure a worktree setup script when one is missing
- Choose whether the daemon shuts down when you close the desktop app

### Improved

- Provider settings and model selection have been redesigned
- Voice mode transcription endpoint is configurable for OpenAI-compatible providers ([#570](https://github.com/getpaseo/paseo/pull/570) by [@yuruiz](https://github.com/yuruiz))
- Adding a project no longer waits for GitHub PR status to load
- Startup splash screen is cleaner — just the logo with a subtle shimmer
- `paseo.json` setup and teardown accept a single command string, not just an array
- Archiving a worktree is instant instead of waiting for the backend to confirm
- Agent timelines and git diff lists no longer jump around while loading or streaming

### Fixed

- `paseo loop run` and `paseo run` now respect the `--provider` and `--model` flags ([#594](https://github.com/getpaseo/paseo/pull/594) by [@VincenzoRocchi](https://github.com/VincenzoRocchi))
- Pi provider shows up when only DeepSeek or other non-OpenAI/Anthropic/OpenRouter API keys are set
- Custom models from `additionalModels` and `profileModels` are honored when picking a default for new agents
- File preview line numbers stay on one line past line 99
- Cmd+Q on macOS quits the desktop app instead of leaving it running in the background
- Terminal sessions recover cleanly after rendering hiccups, including the initial resize for nvim
- Terminal protocol query responses no longer leak into the browser
- Assistant link color matches the theme again
- File links with line numbers (like `foo.ts:42`) open correctly from assistant messages
- Claude's Grep results show up in the search detail body
- Reopening a worktree lands under the right project
- Agents from disabled or unavailable providers stay visible in history
- New CLI agents now require a provider instead of failing silently
- Git diff headers no longer truncate
- Provider diagnostic modal scrolls on short screens
- Provider diagnostics show the real error and underlying child-process output instead of a generic message
- Archived workspaces no longer interfere with working-directory resolution
- Triple-click on a message no longer extends the selection into adjacent bubbles
- The packaged desktop app preserves your zsh prompt

## 0.1.62 - 2026-04-23

### Added

- Sidebar warning when your app and daemon versions drift apart, with a shortcut to settings

### Improved

- Workspaces appear in the sidebar immediately on startup instead of waiting for git registration

### Fixed

- Pull request status resolves correctly for PRs opened from forks
- Installing the paseo CLI from the macOS desktop app now works in packaged builds
- Agents launched from the desktop app no longer inherit Electron-only environment variables

## 0.1.61 - 2026-04-23

### Added

- `additionalModels` option in provider config lets you add or relabel models without replacing the full list — entries merge with runtime-discovered models (ACP) or your static `models` list. See the [Providers docs](https://paseo.sh/docs/providers)
- New [Providers docs page](https://paseo.sh/docs/providers) covering first-class providers and every custom provider config pattern in one place

### Improved

- Pi loads your installed extensions on startup so their models show up in the model picker
- Resizing the explorer sidebar no longer rerenders the rest of the workspace
- Images in assistant messages (both file paths and inline data URLs) persist as local attachments and open in the file pane

## 0.1.60 - 2026-04-22

### Added

- Scripts and services per worktree — define named commands in `paseo.json`, and long-running services get supervised with their own ports and nice proxy URLs like `http://web.my-app.localhost:6767`. See the [worktrees guide](https://paseo.sh/docs/worktrees)
- Launch scripts and services for a worktree directly from the workspace header
- New Setup tab in every workspace showing setup, teardown, and script progress live
- GitHub checks and PR reviews in the explorer sidebar, with a hover card for the full breakdown
- New worktree creation flow lets you pick a base branch or check out an existing GitHub pull request
- Attach GitHub issues and pull requests to an agent as part of its prompt context
- Pull request pane in the workspace sidebar
- Redesigned Settings screen with modular section navigation
- Per-host provider configuration — set providers, models, and credentials independently on each remote host
- Direct Pi integration replaces the ACP bridge, with faster streaming and fewer hiccups
- Beta release channel — opt in from Settings to receive beta desktop builds before they are promoted to stable
- New-workspace picker ranks branches by recency with fast search

### Improved

- Workspace and tab switching are dramatically faster on desktop and mobile — you can keep many workspaces open in parallel without lag
- Agent streams render more smoothly during heavy tool output
- App startup routes through a stable connection and lands on the right screen without flicker
- Provider refresh is reliable and no longer stalls on transient failures
- Git and GitHub state stay in sync with local changes like commits, branch switches, and pushes
- Composer attachments redesigned with a cleaner pill layout and an image lightbox
- In-app notifications route to whichever surface you're actually looking at
- Keyboard shortcuts keep working while Settings is open
- Escape reliably interrupts the active agent
- Checking out a pull request from a fork lands on an owner-prefixed branch so multiple forks don't collide
- `paseo ls` defaults to active agents; pass `-a` to include archived
- GitHub branch and PR picker loads faster — queries are deferred until the picker opens

### Fixed

- Composer textarea shrinks back down after sending on web
- New workspace drafts clear after submit instead of sticking around
- Replacing a running agent cleans up the previous one without leaving it behind
- Agent notifications no longer get swallowed by a backgrounded focused client
- Removed workspace folders disappear from the workspace list again
- Codex keeps fast mode after you approve a plan ([#526](https://github.com/getpaseo/paseo/pull/526) by [@therainisme](https://github.com/therainisme))
- Workspace tab focus is preserved across page refreshes
- Settings screen no longer pushes its header down with extra spacing
- Branch switcher title no longer overflows on narrow rows
- iOS image picker no longer leaves the screen unresponsive after cancelling
- Archiving a worktree recovers cleanly if a previous attempt was interrupted
- Images in agent messages with `~`-prefixed paths load instead of spinning forever
- Tool call blocks expand correctly on mobile while an agent is still streaming
- Timeline no longer stutters when catch-up and projected ranges overlap
- Codex no longer flashes idle when a replacement turn is in progress
- Branch state recovers correctly when a rebase is in progress
- Workspace hover card no longer clips near screen edges

## 0.1.59 - 2026-04-16

### Added

- Opus 4.7 in the Claude model picker, with a 1M-context variant
- Extra High reasoning effort for Opus 4.7, between High and Max

## 0.1.58 - 2026-04-16

### Added

- Markdown files render as formatted markdown in the file pane ([#427](https://github.com/getpaseo/paseo/pull/427) by [@aaronflorey](https://github.com/aaronflorey))
- Cmd+L (Ctrl+L on Windows/Linux) focuses the agent message input
- Provider models refresh on a freshness TTL; Settings shows last-updated time and any fetch errors ([#426](https://github.com/getpaseo/paseo/pull/426))
- `disallowedTools` option in provider config to block specific tools from an agent

### Improved

- Windows: agents launch reliably from npm `.cmd` shims, paths with spaces, and JSON config args — fixes `spawn EINVAL` startup errors ([#454](https://github.com/getpaseo/paseo/pull/454))
- OpenCode permission prompts include the requesting tool's context ([#398](https://github.com/getpaseo/paseo/pull/398) by [@aaronflorey](https://github.com/aaronflorey))
- OpenCode todo and compaction events render in the timeline ([#429](https://github.com/getpaseo/paseo/pull/429) by [@aaronflorey](https://github.com/aaronflorey))
- OpenCode sessions archive cleanly when closed ([#408](https://github.com/getpaseo/paseo/pull/408) by [@aaronflorey](https://github.com/aaronflorey))
- OpenCode slash commands recover from SSE timeouts ([#407](https://github.com/getpaseo/paseo/pull/407) by [@aaronflorey](https://github.com/aaronflorey))
- Paseo MCP tools work against archived agents, matching the CLI ([#423](https://github.com/getpaseo/paseo/pull/423))
- Native scrollbars match the active theme across all web views ([#399](https://github.com/getpaseo/paseo/pull/399) by [@ethersh](https://github.com/ethersh))

### Fixed

- Code file previews can be selected and copied on iOS ([#447](https://github.com/getpaseo/paseo/pull/447) by [@muzhi1991](https://github.com/muzhi1991))
- File preview no longer shows stale content when reopening the same file ([#411](https://github.com/getpaseo/paseo/pull/411) by [@muzhi1991](https://github.com/muzhi1991))
- File explorer reinitialises when the client reconnects after a page refresh ([#442](https://github.com/getpaseo/paseo/pull/442) by [@1996fanrui](https://github.com/1996fanrui))
- Generic ACP providers no longer receive duplicated command arguments ([#444](https://github.com/getpaseo/paseo/pull/444) by [@edvardchen](https://github.com/edvardchen))
- Workspace headers no longer show a branch icon for non-git workspaces
- Branch switcher layout is stable on mobile
- Model names no longer truncate mid-word in the picker rows
- Messages appear in the correct order after reconnecting on mobile
- Clearing agent attention no longer throws on timeout

## 0.1.56 - 2026-04-14

### Fixed

- Projects with empty git repositories (no commits yet) no longer crash the app on startup
- A single problematic project can no longer prevent the rest of your workspaces from loading

## 0.1.55 - 2026-04-14

### Added

- Provider profiles — define custom providers in your Paseo config that appear alongside built-ins. Override a built-in's binary, env, or models, or create entirely new providers. See the [configuration guide](https://github.com/getpaseo/paseo/blob/main/docs/custom-providers.md)
- ACP agent support — add any ACP-compatible agent to Paseo with `extends: "acp"` in your provider config. No code changes needed
- Choose provider and model when creating scheduled agents
- Max reasoning effort option for Opus 4.6 models
- Cmd+, (Ctrl+, on Windows/Linux) opens settings

### Improved

- Git operations are dramatically faster — workspace status, PR checks, and branch data all use a shared cached snapshot service instead of shelling out to git on every request. Running 20+ workspaces simultaneously is now smooth
- Windows support — the daemon and CLI run natively on Windows with proper shell quoting, executable resolution, and path handling
- iPad and tablet layouts work correctly across all screen sizes
- IME composition (Chinese, Japanese, Korean input) no longer submits prematurely when pressing Enter

### Fixed

- Creating a worktree no longer briefly flashes it as a standalone project before placing it under the correct repository
- Worktree creation spinner stays visible throughout the process instead of disappearing on mouse-out
- Workspace navigation updates correctly when switching between workspaces in the same project
- Desktop workspace header alignment and model selector no longer overflow on narrow windows
- Loading indicators are visible in light mode

## 0.1.54 - 2026-04-12

### Added

- Inline image previews in agent messages — screenshots and images generated by agents render directly in the conversation instead of showing as raw markdown links

### Improved

- Paseo tools are no longer injected into agents by default — opt in from Settings when you need agent-to-agent orchestration
- Agent provider and mode are now resolved server-side, so CLI commands like `paseo run` use consistent defaults without client-side lookups

### Fixed

- Shift+Enter now correctly inserts a newline in agent terminal input instead of submitting
- Windows: MCP configuration is no longer mangled when spawning Claude agents
- Branch ahead/behind count no longer errors for branches with no remote tracking branch

## 0.1.53 - 2026-04-12

### Added

- Agents get Paseo tools automatically — every new agent gets access to terminals, schedules, worktrees, and other agents through MCP. Toggle it off in Settings under "Inject Paseo tools"
- Git pull — pull remote changes directly from the workspace header. Promoted to the primary action when your branch is behind origin
- Child agent notifications — parent agents are automatically notified when a child agent finishes, errors, or needs permission approval
- Agent reload — `paseo agent reload` restarts an agent's underlying process from the CLI
- Middle-click to close tabs on desktop
- Keyboard shortcut to cycle themes

### Improved

- Unavailable git actions now explain why in a toast instead of being silently greyed out
- Streaming markdown on mobile renders significantly faster
- Sidebar, branch switcher, and agent panel no longer re-render unnecessarily — noticeable on large workspaces
- Paseo tool calls in agent timelines show the Paseo logo and human-readable names
- Relay and pairing URLs are stripped from daemon logs

### Fixed

- Closed agent tabs no longer reappear after reconnecting
- Desktop notification badge counts match across all workspaces
- Host switcher status syncs correctly when switching between hosts

## 0.1.52 - 2026-04-10

### Added

- Theme selector — choose from six themes including Midnight, Claude, and Ghostty dark variants
- Branch switching — switch git branches directly from the workspace header, with automatic stash and restore for uncommitted changes
- Auto-download updates — desktop updates download silently in the background so they're ready to install when you are

### Fixed

- Layout now responds correctly when resizing the window or rotating a tablet — previously the app could get stuck in mobile layout on a large screen
- Terminal no longer causes massive memory spikes from snapshot thrashing during heavy output
- Typing in the terminal works reliably — special keys, Ctrl combos, and paste are handled natively by the terminal emulator
- Initializing agents no longer show a loading spinner as if they're running
- Reconnecting to a running agent now works even when session persistence is unavailable
- Error screens on desktop are now scrollable
- Model list refreshes in the background when you open the model selector
- Draft agent feature preferences (like thinking mode) are remembered across sessions

## 0.1.51 - 2026-04-09

### Added

- Image attachments for OpenCode — attach screenshots and images to OpenCode agent prompts
- WebStorm — added to the "Open in editor" list alongside Cursor, VS Code, and Zed
- Send behavior setting — choose whether pressing Enter while an agent is running interrupts immediately or queues your message

### Fixed

- Model selector no longer crashes on iPad
- Pairing now uses the correct hostname, fixing connection failures on some network setups
- OpenCode agents show the correct terminal state and refresh models reliably
- Follow-up messages to agents that just finished a turn now work correctly
- Commands now load properly for Pi agents
- Internal debug output no longer appears in Claude agent timelines
- QR scan screen cleaned up with simpler visuals

## 0.1.50 - 2026-04-07

### Added

- Context window meter — see how much of the context window your agent has used, with color thresholds at 70% and 90%. Works with Claude Code, Codex, and OpenCode
- Open in editor — jump from any workspace straight into Cursor, VS Code, Zed, or your file manager. Paseo remembers your choice
- Side-by-side diffs — toggle between unified and split-column diff views, with a whitespace visibility option
- Spoken messages — when using voice mode, agent speech now appears as regular messages in the conversation instead of raw tool output
- Plan actions — plan cards now show the actions your agent supports (e.g. "Implement", "Deny") instead of generic accept/reject buttons
- Background git fetch — ahead/behind counts in the Changes pane stay up to date automatically

### Improved

- Workspaces load instantly on connect instead of waiting for a full sync
- File explorer and diff pane remember which folders are expanded when you switch tabs
- Closing a workspace tab is now instant
- Settings shows a Refresh button for providers and displays error details inline
- Reload agent moved away from the close button to prevent accidental taps

### Fixed

- Voice mode no longer drifts into false speech detection during long sessions
- Garbled overlapping text on plan cards
- Changes pane could show stale diffs when working with git worktrees
- Restarting an agent quickly could crash the session
- Copilot no longer pauses for permission prompts in autopilot mode
- Connection and pairing dialogs now display correctly on tablets
- Orchestration errors from agents are now surfaced instead of silently lost
- Diff stats no longer reset to zero when reconnecting

## 0.1.49 - 2026-04-07

### Fixed

- Models and providers now load reliably on first connect instead of requiring a manual refresh
- Model picker only shows models from the agent's own provider, not every provider on the server
- Model lists stay consistent regardless of which screen you open first

## 0.1.48 - 2026-04-05

### Added

- Provider diagnostics — tap a provider in Settings to see binary path, version, model count, and status at a glance. Helps troubleshoot why an agent type isn't available
- Provider snapshot system — daemon now pushes real-time provider availability and model lists to the app, replacing the old poll-based approach. Models and modes update live as providers come online or go offline
- Codex question handling — Codex agents can now ask the user questions mid-session (e.g. "which file?") and receive answers inline, matching the Claude Code question flow
- Reload tab action — right-click a workspace tab to reload its agent list without restarting the app

### Improved

- Model selector redesigned — grouped by provider with status badges, search, and better touch targets on mobile
- Enter key now submits question card answers and confirms dictation, matching the expected keyboard flow
- Removed noisy agent lifecycle toasts that fired on every state change

### Fixed

- Desktop app now resolves the user's full login shell environment at startup, fixing tools like `codex`, `node`, `bun`, and `direnv` not being found when Paseo is launched from Finder or Dock. Terminals spawned by Paseo now inherit the same PATH and environment variables as a normal terminal session. Approach adapted from VS Code's battle-tested shell environment resolution
- Input field on running agent screens now correctly receives keyboard focus
- Mobile model selector alignment and sizing

## 0.1.47 - 2026-04-05

### Fixed

- Voice TTS in Electron — sherpa now requests copied buffers and the voice MCP bridge sets `ELECTRON_RUN_AS_NODE`, preventing "external buffers not allowed" crashes
- QR pairing in desktop — CLI JSON output parsing now tolerates Node deprecation warnings in stdout
- STT segment race condition — segment ID and audio buffer are snapshotted before the async transcription call, so rapid commits no longer interleave
- Per-host "Add connection" button removed — it blocked multi-host setups by scoping new connections to a single server

## 0.1.46 - 2026-04-04

### Fixed

- Voice activation in packaged builds — Silero VAD model is now copied out of the Electron asar archive so native code can read it
- App version sent in probe client hello so the daemon's version gate no longer hides Pi/Copilot from reconnected sessions
- `worktreeRoot` schema made backward-compatible for old clients and daemons that don't send the field
- Punycode deprecation warning (DEP0040) suppressed in CLI and desktop daemon entrypoints

## 0.1.45 - 2026-04-04

### Added

- Pi (pi.dev) agent provider — connect Pi as a new agent type with thinking levels and tool call support
- Copilot agent provider re-enabled after ACP compatibility fixes
- `paseo .` and `paseo <path>` open the desktop app with the given project, similar to `code .`
- Provider-declared features system — providers can expose dynamic toggles and selects that the app renders automatically. First consumer: Codex fast mode
- Codex plan mode — start agents in plan-only mode with a dedicated plan card UI for reviewing proposed changes before execution
- OpenCode custom agents and slash commands — user-defined agents from opencode.json now appear in the mode picker, and slash commands accept optional arguments
- Desktop Integrations settings — install the Paseo CLI and orchestration skills directly from the app without touching the terminal
- Daemon status dialog in desktop settings for quick health checks
- Auto-restart daemon on version mismatch — the desktop app detects when the running daemon is outdated and restarts it automatically
- Setup hint and paseo.sh link on the mobile welcome screen so new App Store users know what to do next

### Improved

- Desktop startup is faster — existing daemon connections are raced against bootstrap so the app is usable sooner
- Settings sections reordered for better grouping (integrations and daemon together)
- Sidebar projects and workspaces now persist across sessions, with a context menu to remove projects

### Fixed

- Sidebar crash when switching iOS theme (Unistyles/Reanimated interaction)
- Silero VAD crash caused by external buffer mode in CircularBuffer
- Bulk close now correctly archives stored agents instead of leaving orphans
- Pinned archived agents are no longer pruned when closing tabs
- OpenCode event stream starvation during slash command execution
- Duplicate workspaces when multiple git worktrees share the same root
- `gh` executable resolution for desktop users whose login shell sets a different PATH
- Agent creation timeout increased to 60s to handle slow first-launch scenarios
- Forward-compatible provider handling so older app clients don't break on new provider types
- Input event listener race condition in the web scrollbar hook
- Open-project screen content now vertically centered
- Website download page fetches the release version at runtime with asset validation, fixing stale links

## 0.1.44 - 2026-04-03

### Fixed

- Desktop app now stops the daemon cleanly before auto-update restarts
- Disabled claude-acp and copilot providers from the agent registry
- Keyboard focus scope resolution now checks multiple candidates for broader compatibility
- OpenCode interrupt now reaches correct terminal state parity with tool-call flows
- Shell injection, symlink escape, and pairing endpoint security hardening

## 0.1.43 - 2026-04-02

### Added

- Copilot agent support via ACP base provider — connect GitHub Copilot as a new agent type
- Searchable model favorites — quickly find and pin preferred models
- Slash command support for OpenCode agents

### Improved

- Refined model selector UX with better mobile sheet behavior
- Workspace status now uses amber alert styling for "needs input" state
- Themed scrollbar on message input for consistent styling

### Fixed

- Ctrl+C/V copy and paste now works correctly in the terminal on Windows and Linux
- Shell arguments with spaces are now properly quoted on Windows
- Claude models with 1M context support are now correctly reported

## 0.1.42 - 2026-04-01

### Fixed

- Fixed Claude Code failing to launch on Windows when installed to a path with spaces (e.g. `C:\Program Files\...`)

## 0.1.41 - 2026-04-01

### Fixed

- Fixed agent spawning on Windows — all providers (Claude, Codex, OpenCode) now use shell mode so npm shims and `.cmd` wrappers resolve correctly
- Fixed terminal creation on Windows defaulting to a Unix shell instead of `cmd.exe`
- Fixed path handling across the app to support Windows drive-letter paths (`C:\...`) and UNC paths (`\\...`)
- Fixed executable resolution on Windows to work with `nvm4w` and similar Node version managers
- Eliminated white flash on window resize in dark mode by setting the native window background color to match the theme
- Fixed titlebar drag region — replaced the fragile pointer-event approach with VS Code's proven static CSS `app-region: drag` pattern
- Fixed context menu for copy/paste across the desktop app
- Fixed shortcut rebinding UI to show held modifier keys and recognize additional keys (Tab, Delete, Home, End, Page Up/Down, Insert, F1–F12)
- Removed the 40-item cap on activity timeline output so long agent sessions display their full history

### Improved

- Improved light mode theming with dedicated workspace background, scrollbar handle colors, and lighter shadows
- Window controls overlay on Windows/Linux reduced from 48px to 29px height for a more compact titlebar

## 0.1.40 - 2026-04-01

### Added

- Workspace tabs can now be closed in batches

### Improved

- Provider model lists are now cached per server and provider, reducing redundant model lookups in the UI

### Fixed

- OpenCode reasoning content no longer appears duplicated as assistant text
- Daemon no longer crashes when a Codex binary is missing or fails to spawn
- Archive tab now correctly reconciles agent visibility after archiving
- File diff tracking in workspaces now works correctly on Linux
- iPad layout now renders correctly in desktop mode
- macOS auto-updater now correctly delivers both arm64 and x64 binaries — previously whichever architecture finished building last would overwrite the other's update manifest

## 0.1.39 - 2026-03-30

### Added

- **Terminal management from the CLI** — new `paseo terminal` command group lets you list, create, and interact with workspace terminals without leaving your terminal
- **Material file icons in the explorer** — the file explorer tree now shows language-specific icons (TypeScript, JSON, Markdown, etc.) so you can spot files at a glance

### Fixed

- Fixed iOS sidebar scroll flicker caused by redundant overflow clipping
- Centralized window controls padding into a shared hook, eliminating layout inconsistencies across platforms

## 0.1.38 - 2026-03-30

### Fixed

- Fixed daemon startup race where the app could time out connecting on first launch because the PID file advertised a listen address before the server was ready
- Fixed daemon log rotation losing startup traces — trace-level WebSocket logs no longer include full message payloads

## 0.1.37 - 2026-03-29

### Added

- Custom window controls on Windows and Linux — the native titlebar is replaced with overlay controls that match the app's design
- Desktop file logging with electron-log for easier debugging of daemon and app issues

### Fixed

- Fixed broken PATH propagation and Claude binary resolution on Windows
- Dictation errors now show a visible toast instead of failing silently

## 0.1.36 - 2026-03-27

### Fixed

- Fixed Windows drive-letter path handling across the codebase
- Fixed stale Nix hash with automatic lockfile-change detection

### Added

- Added metrics collection and terminal performance tests

## 0.1.35 - 2026-03-26

### Improved

- Faster app startup by redirecting to the welcome screen immediately and showing host connection status inline
- Codex file deletions now display correctly as removed lines in diffs
- OpenCode questions are now surfaced in the permission UI

### Fixed

- Fixed queued prompt dispatch after idle transition
- Replaced bash-only `mapfile` with a portable `while-read` loop in the chat script

### Added

- Added support for Nix and NixOS installation

## 0.1.34 - 2026-03-25

### Added

- Added `paseo archive` as a top-level alias for `paseo agent archive`
- Added the `PASEO_AGENT_ID` environment variable for Claude and Codex agents
- Added a redesigned command autocomplete with a detail card and dropdown styling
- Linked Android download surfaces to the Google Play Store

### Improved

- Autonomous turns now complete gracefully on interrupt instead of being canceled
- Thinking/model selection now always resolves to a real option instead of showing a generic Default choice
- Restored per-provider form preferences and removed the Auto model fallback
- Improved Codex activity logs with clearer tool-call summaries
- Reduced unnecessary re-renders in the agent panel and input area for smoother interaction
- Improved chat transcript readability

### Fixed

- Fixed `paseo send --no-wait` not taking effect
- Fixed stale abort results contaminating replacement turns after an interrupt
- Fixed Claude interrupt handling and autonomous wake reliability
- Fixed nested Claude Code session detection and provider availability checks
- Fixed agent input focus scoping across panels
- Fixed terminal snapshot ordering when subscribing
- Fixed `chat read --since` to accept message IDs
- Fixed keyboard pane focus syncing with the active panel
- Fixed assistant text selection on web
- Fixed archived-agent notifications still appearing in chat rooms
- Fixed the attach-images button interaction in the message composer
- Pruned wrong-platform native binaries from Electron desktop builds

## 0.1.33 - 2026-03-23

### Fixed

- Fixed the desktop app failing to reopen after closing on macOS — the daemon and agent processes were registering with Launch Services as instances of the main app, blocking subsequent launches
- Fixed dictation not working in the packaged desktop app — the microphone entitlement was missing from the hardened runtime configuration
- Fixed leaked Claude Code child processes when agents were closed — the SDK query stream was not being properly shut down
- The notification test button now surfaces errors instead of failing silently

## 0.1.32 - 2026-03-23

### Added

- Fully rebindable keyboard shortcuts with chord support — all shortcuts are now declarative with proper Cmd (Mac) vs Ctrl (Windows/Linux) separation
- Migrated the desktop app from Tauri to Electron, with macOS notarization, code signing, and Linux Wayland support
- Added line numbers and word-wrap toggle to file previews
- Added an archived agent callout with an unarchive button so you can restore agents directly from the chat view
- Added workspace kind indicators in the sidebar (e.g. worktree vs standalone)
- Expanded diff syntax highlighting to cover more languages
- Added status bar tooltips for project and agent status

### Improved

- Redesigned the mobile tab switcher as a compact header row with quick access to new agents and terminals
- Streamlined workspace creation — worktrees are now created inline with a single action instead of a multi-step flow
- Agent history now streams from disk on reconnect, so you see past messages immediately instead of a blank screen
- Automatic cleanup of stale workspaces: deleted worktree directories and fully-archived workspaces are pruned automatically
- After archiving a workspace, the app now redirects to the next available workspace instead of leaving you on a dead screen
- Reopening an archived agent tab now keeps it open instead of collapsing back to archived state
- Reduced unnecessary re-renders across the workspace screen, sidebar, and agent list for smoother scrolling and interaction
- Agent list no longer refreshes in the background when the screen is unfocused, saving resources
- Desktop key repeat now works correctly on macOS
- Desktop notifications on macOS are more reliable
- Daemon startup no longer blocks on model downloads
- Better error messages from the daemon — RPC errors now include the actual underlying details

### Fixed

- Fixed user messages appearing as assistant output in the timeline when messages contained structured content blocks
- Fixed archived workspace routing so navigating to an archived session no longer breaks the app
- Fixed Linux AppImage failing to launch on Wayland-only desktops
- Fixed desktop window drag coordinates being applied when they shouldn't be

## 0.1.30 - 2026-03-19

### Added

- Added terminal tabs, split pane controls, and drop previews for workspace layouts
- Added a combined model selector and agent mode visuals across key UI surfaces
- Added Open Graph metadata improvements for richer website sharing previews

### Improved

- Improved workspace navigation with better active-workspace tracking and keyboard-driven pane interactions
- Improved terminal scrollbar behavior, pane focus handling, and status bar/message input spacing
- Improved project picker path display and general workspace UI polish

### Fixed

- Fixed agent startup reliability by tightening PATH resolution and surfacing missing provider binaries in status
- Fixed workspace route syncing, drag hit areas, and git diff panel header styling regressions
- Fixed website mobile horizontal scrolling and ensured the workspace audio module builds during EAS installs

## 0.1.28 - 2026-03-15

### Added

- Added OpenCode build and plan modes
- Added website landing pages for Claude Code, Codex, and OpenCode

### Improved

- Improved the git action menu for more reliable repository actions
- Improved the mobile settings screen, workspace header actions, and welcome screen presentation
- Updated the website hero copy and added a sponsor callout section

### Fixed

- Fixed assistant file links so they open the correct workspace files from chat

## 0.1.27 - 2026-03-13

### Added

- Added voice runtime with new audio engine architecture for voice interactions
- Added Grep tool support in Claude tool-call mapping
- Added ability to open workspace files directly from agent chat messages
- Added desktop notifications via a custom native bridge

### Improved

- Improved image picker, markdown rendering, and UI interactions
- Improved shell environment detection using shell-env

### Fixed

- Fixed platform-specific markdown link rendering
- Fixed Linux AppImage CLI resource paths
- Fixed Codex replacement stream being killed by stale turn notifications

## 0.1.26 - 2026-03-12

### Added

- Added single-instance desktop behavior, Android APK download access, and refreshed splash screen styling
- Added bundled Codex and OpenCode binaries in the server so setup no longer depends on global installs
- Added Windows support with improved cross-platform shell execution

### Improved

- Improved desktop runtime behavior on Windows by suppressing console windows and defaulting app data to `~/.paseo`
- Added a Discord link to the website navigation

### Fixed

- Fixed desktop Claude agent startup from the managed runtime and rotated logs correctly on restart
- Fixed the home route to hide browser chrome when appropriate
- Fixed Expo Metro compatibility by updating the `exclusionList` import
- Fixed noisy shell output interfering with executable lookup
- Fixed Windows resource-path handling by stripping the extended-length path prefix

## 0.1.25 - 2026-03-11

### Fixed

- Fixed desktop app failing to start the built-in daemon on fresh macOS installs. The DMG was not notarized and code-signing stripped entitlements from the bundled Node runtime, causing Gatekeeper to block execution
- Fixed Linux AppImage build by restoring the AppImage bundle format and stripping CUDA dependencies from onnxruntime

## 0.1.24 - 2026-03-10

### Improved

- Improved command center keyboard navigation and new tab shortcut
- Simplified desktop release pipeline for faster and more reliable builds

## 0.1.21 - 2026-03-10

### Improved

- Improved desktop release reliability by fixing the Windows managed-runtime build path during GitHub Actions releases

### Fixed

- Fixed a desktop release CI failure caused by a Unix-only server build script on Windows runners
- Fixed server CI to build the relay dependency before running tests, restoring relay E2EE test coverage on clean runners
- Fixed a Claude redesign test that depended on the local Claude CLI being installed

## 0.1.20 - 2026-03-10

### Added

- Added workspace sidebar git actions with quick diff stats and archive controls
- Added refreshed website downloads and homepage presentation for desktop installs

### Improved

- Desktop release packaging now rebuilds and validates the bundled managed runtime during CI, improving installer reliability for macOS users
- Improved desktop and web stream rendering, settings polish, and React 19.1.4 compatibility

### Fixed

- Fixed Claude interrupt/restart regressions and strengthened managed-daemon smoke coverage for desktop releases

## 0.1.19 - 2026-03-09

### Added

- Added a draft GitHub release flow so maintainers can upload and review desktop and Android release assets before publishing the final release

## 0.1.18 - 2026-03-06

### Added

- Added a desktop `Mod+W` shortcut to close the current tab

### Improved

- New and newly selected terminals now take focus automatically so you can type immediately
- Kept newly created workspaces and projects in a more stable order in the sidebar
- Improved project naming for GitHub remotes and expanded project icon discovery to Phoenix `priv/static` assets
- Updated the website desktop download link to use the universal macOS DMG

### Fixed

- Restored automatic agent metadata generation for Claude runs

## 0.1.17 - 2026-03-06

### Added

- New workspace-first navigation model with workspace tabs, file tabs, and sortable tab groups
- Keyboard shortcuts for workspace and tab navigation, with shortcut badges in the sidebar
- Workspace-level archive actions with improved worktree archiving flow and context menu support
- In-chat task notifications rendered as synthetic tool-call events for clearer status tracking

### Improved

- Desktop builds now ship as a universal macOS binary (Apple Silicon + Intel)
- More reliable workspace routing and tab identity handling across refreshes and deep links
- Better sidebar drag-and-drop behavior with explicit drag handles and nested list interactions
- Smoother terminal/file rendering and WebGL-backed terminal performance improvements
- Stronger provider error surfacing and updated Claude model/runtime handling

### Fixed

- Fixed orphan workspace runs caused by non-canonical tab routes
- Fixed mobile terminal tab remount/routing restore issues
- Fixed agent metadata title/branch update reliability
- Fixed stream/timeline ordering and cursor synchronization issues in the app
- Fixed reversed edge-wheel scroll behavior in chat/tool stream views

## 0.1.16 - 2026-02-22

### Added

- Update the Paseo desktop app and local daemon directly from Settings
- Microphone and notification permission controls in Settings
- Thinking/reasoning mode — agents can use extended thinking when the provider supports it
- Autonomous run mode — let agents keep working without manual approval at each step
- `paseo wait` now shows a snapshot of recent agent activity while you wait

### Improved

- Smoother streaming with less UI flicker and scroll jumping during long agent runs
- Faster agent sidebar list rendering
- Archiving an agent now stops it first instead of archiving a half-running session
- Agent titles no longer reset when refreshing
- More reliable relay connections

### Fixed

- Fixed Claude background tasks desyncing the chat
- Fixed duplicate user messages appearing in the timeline
- Fixed a startup crash caused by an OpenCode SDK update
- Fixed spurious "needs attention" notifications from background agent activity

## 0.1.15 - 2026-02-19

### Added

- Added a public changelog page on the website so users can browse release notes

### Improved

- Redesigned the website get-started experience into a clearer two-step flow
- Simplified website GitHub navigation and changelog headings
- Improved app draft/new-agent UX with clearer working directory placeholder and empty-state messaging
- Enabled drag interactions in previously unhandled areas on the desktop draft screen
- Hid empty filter groups in the left sidebar

### Fixed

- Fixed archived-agent navigation by redirecting archived agent routes to draft
- Fixed duplicate `/rewind` user-message behavior

## 0.1.14 - 2026-02-19

### Added

- Added Claude `/rewind` command support
- Added slash command access in the draft agent composer
- Added `@` workspace file autocomplete in chat prompts
- Added support for pasting images directly into prompt attachments
- Added optimistic image previews for pending user message attachments
- Added shared desktop/web overlay scroll handles, including file preview panes

### Improved

- Improved worktree flow after shipping, including better merged PR detection
- Improved draft workflow by enabling the explorer sidebar immediately after CWD selection
- Improved new worktree-agent defaults by prefilling CWD to the main repository
- Improved desktop command autocomplete behavior to match combobox interactions
- Improved git sync UX by simplifying sync labels and only showing Sync when a branch diverges from origin
- Improved desktop settings and permissions UX on desktop
- Improved scrollbar visibility, drag interactions, tracking, and animation timing on web/desktop

### Fixed

- Fixed worktree archive/setup lifecycle issues, including terminal cleanup and archive timing
- Fixed worktree path collisions by hashing CWD for collision-safe worktree roots
- Fixed terminal sizing when switching back to an agent session
- Fixed accidental terminal closure risk by adding confirmation for running shell commands
- Fixed archive loading-state consistency across the sidebar and agent screen
- Fixed autocomplete popover stability and workspace suggestion ranking
- Fixed dictation timeouts caused by dangling non-final segments
- Fixed server lock ownership when spawned as a child process by using parent PID ownership
- Fixed hidden directory leakage in server CWD suggestions
- Fixed agent attention notification payload consistency across providers
- Fixed daemon version badge visibility in settings when daemon version data is unavailable

## 0.1.9 - 2026-02-17

### Improved

- Unified structured-output generation through a single shared schema-validation and retry pipeline
- Reused provider availability checks for structured generation fallback selection
- Added structured generation waterfall ordering for internal metadata and git text generation: Claude Haiku, then Codex, then OpenCode

### Fixed

- Fixed CLI `run --output-schema` to use the shared structured-output path instead of ad-hoc JSON parsing
- Fixed `run --output-schema` failures where providers returned empty `lastMessage` by recovering from timeline assistant output
- Fixed internal commit message, pull request text, and agent metadata generation to follow one consistent structured pipeline

## 0.1.8 - 2026-02-17

### Added

- Added a cross-platform confirm dialog flow for daemon restarts

### Improved

- Simplified local speech bootstrap and daemon startup locking behavior
- Updated website hero copy to emphasize local execution

### Fixed

- Fixed stuck "send while running" recovery across app and server session handling
- Fixed Claude session identity preservation when reloading existing agents
- Fixed combobox option behavior and related interactions
- Fixed desktop file-drop listener cleanup to avoid uncaught unlisten errors
- Fixed web tool-detail wheel event routing at scroll edges

## 0.1.7 - 2026-02-16

### Added

- Improved agent workspace flows with better directory suggestions
- Added iOS TestFlight and Android app access request forms on the website

### Improved

- Unified daemon startup behavior between dev and CLI paths for more predictable local runs
- Improved website app download and update guidance

### Fixed

- Prevented an initial desktop combobox `0,0` position flash
- Fixed CLI version output issues
- Hardened server runtime loading for local speech dependencies

## 0.1.6 - 2026-02-16

### Notes

- No major visible product changes in this patch release

## 0.1.5 - 2026-02-16

### Added

- Added terminal reattach support and better worktree terminal handling
- Added global keyboard shortcut help in the app
- Added sidebar host filtering and improved agent workflow controls

### Improved

- Improved worktree setup visibility by streaming setup progress
- Improved terminal streaming reliability and lifecycle handling
- Preserved explorer tab state so context survives navigation better

## 0.1.4 - 2026-02-14

### Added

- Added voice capability status reporting in the client
- Added background local speech model downloads with runtime gating
- Added adaptive dictation finish timing based on server-provided budgets
- Added relay reconnect behavior with grace periods and branch suggestions

### Improved

- Improved connection selection and agent hydration reliability
- Improved timeline loading with cursor-based fetch behavior
- Improved first-run experience by bootstrapping a default localhost connection
- Improved inline code rendering by auto-linkifying URLs

### Fixed

- Fixed Linux checkout diff watch behavior to avoid recursive watches
- Fixed stale relay client timer behavior
- Fixed unnecessary git diff header auto-scroll on collapse

## 0.1.3 - 2026-02-12

### Added

- Added CLI onboarding command
- Added CLI `--output-schema` support for structured agent output
- Added CLI agent metadata update support for names and labels
- Added provider availability detection with normalization of legacy default model IDs

### Improved

- Improved file explorer refresh feedback and unresolved checkout fallback handling
- Added better voice interrupt handling with a speech-start grace period
- Improved CLI defaults to list all non-archived agents by default
- Improved website UX with clearer install CTA and privacy policy access

### Fixed

- Fixed dev runner entry issues and sherpa TTS initialization behavior

## 0.1.2 - 2026-02-11

### Notes

- No major visible product changes in this patch release

## 0.1.1 - 2026-02-11

### Added

- Initial `0.1.x` release line

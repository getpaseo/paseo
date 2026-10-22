# Explorer sidebar and side pane

The Explorer sidebar and the side pane share panel implementations, but they have different shell
contracts.

| Surface          | Purpose                      | Lifecycle                                  |
| ---------------- | ---------------------------- | ------------------------------------------ |
| Explorer sidebar | Files and Changes navigation | Cmd+E shows or hides the dedicated dock    |
| Side pane        | Ordinary workspace content   | Created and closed like any workspace pane |

## Panel host contract

Every desktop panel registers its supported `PaneHost` values and presentation. Launchers derive
fixed-target labels and icons from that registration, filter by host, and never substitute one
panel type for another. Tab moves reject unsupported destinations, and placement resolves only to
a compatible pane.

Files and Changes are the Explorer defaults. Their panel manifests mark them as singletons,
so a pane’s + menu omits each while that pane already contains it. Closing one makes its menu
item available again. Other compatible tabs, including agents, terminals, files, and diffs,
can move between Explorer and main panes.
Keep panel implementations independent of either shell. `WorkspacePanelHost` owns mounting and
retention, while each shell owns its tabs, focus, dragging, resizing, and shortcuts.

## Explorer sidebar

`packages/app/src/workspace-tabs/explorer-sidebar.ts` owns show, hide, toggle, and view selection.
On desktop, the shell is rendered outside the workspace split canvas so it divides the full
workspace, including the header. It has its own persisted width and resize handle. Main-pane splits
never read or modify that width.

`packages/app/src/workspace-tabs/open-supporting-view.ts` owns semantic Changes and pull-request
opens. Compact and wide native layouts select the matching Explorer tab. Desktop Changes opens
follow the shared diff preference. Desktop pull requests use their Main panel, On the side, or
Explorer sidebar setting. Automatic PR discovery follows that preference once per workspace without
interrupting the user's work. Closing the tab opts that workspace out of future automatic opens,
even for a different PR; moving or reordering it remains the user's choice.
Callers request the content and never choose the shell.
The composer Changes pill is a two-stage desktop action: it first reveals Explorer on Changes, then
routes later presses to the working diff through the shared diff preference.

The persisted layout still contains the Explorer pane so tabs survive reloads. The renderer removes
that pane from the workspace split tree and docks it separately. Persisted identifiers retain the
literal `"explorer"` pane id and `explorerPaneIdByWorkspace` key for compatibility.

Explorer uses the shared workspace tab row and ordinary tab context menus. Files and Changes
hide their close buttons through the panel manifest; close them from the tab context menu.
Other tabs reveal the close control on hover. The + menu opens compatible panels in the dock and
omits Agent and terminal profiles. Agents and terminals can still be dragged into Explorer.
Bulk-close actions apply only to the dock's tabs. Explorer tabs can be reordered and dragged
between compatible panes, but the dock cannot be split or maximized. Selecting an Explorer tab
does not change workspace focus.

On desktop, the lower 35% of Explorer holds one workspace shell and the latest service script
terminal. A vertical resize handle stores the height per workspace. The shell is created only after
the workspace directory and terminal list are available; its terminal id is reused when Explorer
reopens. A closed shell stays closed until the user relaunches it. The Script tab appears after Play
starts a service and selects that terminal. Hiding Explorer and switching workspaces never kills
either process. The shell id, selected terminal tab, and height belong to the workspace, outside
the ordinary pane layout.

Cmd+E shows or hides Explorer without changing its selected view. Compact layouts use the combined
full-screen Explorer overlay for Changes, Files, and pull requests, and close it after a file opens. Compact Changes has no tree rail; its overview is the Jump to file action (`packages/app/src/git/jump-to-file/`), a sheet over the same changed-files tree the desktop rail renders.
Wide native layouts without pane splits use the same combined content in a resizable inline dock;
opening a file leaves that dock visible. Both presentations keep their selection in the panel store
and reuse the layout store's per-workspace Explorer width. They do not create a second Explorer
lifecycle.

## Side pane

`packages/app/src/workspace-tabs/open-beside.ts` owns content opened beside the user's work. The
layout store remembers one ordinary pane per workspace. The first side open creates a full-height
right split around the workspace root; later side opens reuse it.

Removing a pane clears its remembered id; a later side open creates a new pane. The last visible
ordinary pane stays when its final tab closes and shows the New launcher. An empty workspace does
not automatically create an agent draft tab; choosing Agent opens one. Explorer cannot replace the
workspace canvas, even when visible. Restoring a saved layout enforces the same rule while preserving Explorer and saved
tab content. Ordinary side panes have no hidden lifecycle; the browser pane below owns its separate visibility contract.

Placement intent still controls existing tabs:

| Mode      | New target                  | Existing target                   |
| --------- | --------------------------- | --------------------------------- |
| `pane`    | opens in the requested pane | moves to the requested pane       |
| `prefer`  | opens in the requested pane | stays where the user placed it    |
| `focused` | opens in the focused pane   | focuses it where it already lives |
| `ambient` | opens in a compatible pane  | focuses it where it already lives |

Explicit **Open to Side** uses `pane`. Implicit opens use `prefer`, so a preference affects only a
new target and never yanks an existing tab out of a user-selected pane.

## Browser pane

Electron remembers one browser-only ordinary pane per workspace. User opens reveal that pane on the right at 65% of the central canvas, hide Explorer and exit
maximization. Remaining conversation splits keep their relative proportions. When the browser is
the only content pane, opening it adds a launcher on the left. Agent opens create or reuse it in
the background, preserving conversation focus and visible width.
Show and Hide affect this pane without closing its pages. Maximize is temporary presentation state;
hiding the pane or revealing another pane clears it without rewriting saved split sizes.

Tabs stay in the shared workspace layout. Each page has a distinct browser id even when URLs match.
Browser pages share that dedicated pane. The + button and Cmd/Ctrl+T create a blank page and focus
its address, including shortcuts from guest pages and iframes. Outside the browser, Cmd/Ctrl+T
keeps the workspace launcher. Explicit placements and tab moves reject mixed browser/content panes.
Restoring old layouts gathers browser tabs into one pane without replacing their identities or state;
agents and terminals stay in their panes. No browser toggle closes a terminal or archives an agent.

Route user HTTP(S) links through `utils/open-web-url.ts`, passing the click event before any async
work. See [link routing](../public-docs/plugins/reference.md#external-links-and-workspace-browsers) for
the platform click policy. Browser pages keep ordinary navigation and authentication
popups; the guest preload forwards Command-click on HTTP(S) anchors to the system browser.

Manual close remembers one URL, viewport, tab role and former pane for Reopen last closed tab in the All tabs
menu. The descriptor lasts only for this app session and is consumed on a successful reopen. Reopen
creates a fresh page; it does not restore history, form state or DOM. Agent closes and workspace purge
do not replace this descriptor. Purging a workspace releases all its browser guests without touching
another workspace. Closing the final visible ordinary tab retains the New launcher.

Resident guests retain their DOM across selection, hide and maximize transitions. Their native
presentation and automation capture constraints belong to [Browser Capture Harness](browser-capture-harness.md).
The globe selects the last classic page or opens a blank one; clicking it again hides the pane.
The neighboring robot opens the official agent-browser dashboard in one reusable tab per workspace.
This access requires Electron, the local host, `workspaceAgentBrowser` and agent-browser 0.37.1 or later.
Closing or hiding the tab leaves the dashboard and its sessions running.

Paseo injects `AGENT_BROWSER_NAMESPACE` into newly launched/resumed agents and workspace terminals.
It hashes the absolute Paseo home and workspace id, so two installations or workspaces can use the
same explicit session name independently. `AGENT_BROWSER_SESSION` defaults to a stable agent or
terminal identity; `--session` still overrides it. OpenCode binds these variables per session;
Codex also sets them in its shell environment policy. Native provider subagents inherit their
parent's environment. Existing processes and unassociated sessions are left alone.

The daemon starts the installed dashboard on demand with that same namespace and an available
loopback port. Concurrent requests share the launch; later requests reuse the namespaced process.
No tool installation or browser session creation happens when opening the dashboard.

## Routing preferences

Desktop **Settings → Layout → Open location** has independent Main panel or On the side choices for
Explorer Files, diffs, chat files, files opened from diffs, and subagents. They default to Main
panel. Mobile ignores them.

Pull requests have a three-way open location: Main panel, On the side, or Explorer sidebar. Explorer
sidebar is the default. Compact layouts always open pull requests in Explorer regardless of this
desktop preference.

Panels request an implicit open through the narrow `openPreferredTarget(target, source)` pane
contract. Entry points outside panels use `openPreferredWorkspaceTarget`. Do not branch on a
specific shell inside a panel.

# Explorer sidebar and side pane

The Explorer sidebar and the side pane share panel implementations, but they have different shell
contracts.

| Surface          | Purpose                      | Lifecycle                                  |
| ---------------- | ---------------------------- | ------------------------------------------ |
| Explorer sidebar | Files and Changes navigation | Cmd+E shows or hides the dedicated dock    |
| Side pane        | Ordinary workspace content   | Created and closed like any workspace pane |
| Sheets           | Compact look-ups             | One tab each, on the app-wide sheet stack  |

## Panel host contract

Every panel registers its supported `PaneHost` values and presentation. Launchers derive
fixed-target labels and icons from that registration, filter by host, and never substitute one
panel type for another. Tab moves reject unsupported destinations, and placement resolves only to
a compatible pane.

Files and Changes are the Explorer defaults. Their panel manifests mark them as singletons,
so a pane’s + menu omits each while that pane already contains it. Closing one makes its menu
item available again. Other compatible tabs, including agents, terminals, files, and diffs,
can move between Explorer and main panes.
Keep panel implementations independent of either shell. `WorkspacePanelHost` owns mounting and
retention. The shared Explorer owns its tab rail; its shared frame owns visibility, activity and
close-gesture lifetime. Platform adapters own resizing and inset geometry.
The host keeps three recently used tabs plus modified tabs; unmodified tabs beyond that budget
can remount. Native retained content stays live, while web chat uses its existing deferred Freeze.

## Sheets

On compact layouts, files and subagents open in a sheet over the workspace, so the tab switcher
keeps only agents and terminals. A panel kind opts in with `compactSheet` in its manifest
(`packages/app/src/panels/panel-manifest.ts`), and the layout store's `openTab` decides between
sheet and tab, so callers open targets the same way on every layout. Each such sheet holds one
ordinary `WorkspaceTab` (`SheetTab` in the store) and is an `IsolatedBottomSheetModal` like every
other sheet in the app, so it sits on the one app-wide stack: a sheet opened from any sheet, a
subagent chosen from the subagents list included, lands on top of it, and closing the top sheet
(drag, Close, backdrop, or Android Back) uncovers the one below. The list stays open under the
sheet it opened; see [menus.md](menus.md#selecting-an-item-on-ios) for the row contract.

The store keeps `sheetsByWorkspace` in opening order and never reorders it, because moving a sheet
remounts its panel. Revealing a target that already has a sheet uncovers that sheet by closing the
ones above it, except ones holding unsaved work, which stay where they are. Opening a sheet as a tab
dismisses the sheets above it, since the tab would sit under them. The stack is not persisted.

Sheets are modal and cover the whole compact workspace, including the header and Explorer. A sheet's header is its drag
handle, because the panel scrolls on its own and content panning would fight it. Its trailing rail
holds icon buttons only (`SheetHeaderIconButton`): Open as tab is the full-screen glyph beside
Close, so the title keeps its width. The sheets present
from the shared workspace's `SheetHostScope`, so their panels read the navigator and every
workspace provider an ordinary pane has without a context bridge
([floating-panels.md Gotcha 6](floating-panels.md#gotcha-6--bottom-sheet-refs-are-not-lifecycle-truth)).

A sheet holding unsaved work is never implicitly displaced; only its guarded close removes it.
Moving its tab to another host remounts the panel, and the file editor keeps unsaved text in the
mounted view, so the move would drop it. Widening the layout is the known exception: it still moves
the sheet's tab into a pane, and edits the autosave has not started writing are lost.

## Explorer sidebar

`packages/app/src/workspace-tabs/explorer-sidebar.ts` owns show, hide, toggle, and view selection.
One Explorer host stays beside the center column across compact overlays and docks. Keep its
providers and gesture roots at the same React position when width or appearance changes. The
workspace route preserves panel ancestry during appearance updates. Appearance-dependent leaves
subscribe to theme changes; the file editor reconfigures its existing editor theme compartment.
Ordinary leaf routes retain the stack appearance policy.
The shell is outside the workspace split canvas so it divides the full workspace, including the header. It has its own persisted width and resize handle. Main-pane splits
never read or modify that width.

`packages/app/src/workspace-tabs/open-supporting-view.ts` owns semantic Changes and pull-request
opens. Compact and wide native layouts select the matching workspace tab in Explorer. Desktop Changes opens
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
Other tabs reveal the close control on hover. The + menu opens compatible panels in the dock, including Agent and terminal profiles.
Web also supports dragging agents and terminals into Explorer.
Bulk-close actions apply only to the dock's tabs. Explorer tabs can be reordered and dragged
between compatible panes, but the dock cannot be split or maximized. Selecting an Explorer tab
does not change workspace focus. Web dragging shares the workspace drag scope; compact layouts
accept only reordering inside the source pane.

Cmd+E shows or hides Explorer without changing its selected view. All layouts use the same
workspace tabs, launcher, and panel host. Below 600 points the shell is the swipeable Explorer
overlay; at 600 points and above it reserves width beside the workspace. Native docking keeps its
touch resize handle. Full workspace splits remain a separate web-only capability.

The dock reserves at least 240 points and the workspace 360. App navigation yields when it cannot
share the remaining width with both. This keeps a portrait tablet from rendering three unusably
narrow columns; widening restores navigation without changing its saved open state.

Compact panel gestures own overlay visibility; the workspace layout owns its tab selection and
contents on every platform. Explicit pane destinations bypass compact sheet placement, so choosing
a panel in Explorer's + menu keeps it there. Ordinary compact file and subagent look-ups still use
the sheet policy. Resolving an existing main tab reveals center immediately; a new file sheet
keeps Explorer underneath and closing the sheet uncovers it. Semantic navigation resolves the
actual destination before revealing it, including deduplicated targets.

Compact overlay selection and saved dock visibility are independent. Folding changes geometry,
not either mode’s visibility intent. Native workspace retention remains one workspace; web retains
up to ten with its existing inactive TTL.

PR discovery belongs to the active workspace: split layouts discover while active, and other
layouts discover while Explorer is active. The rail requests summary status; selected visible PR
content also requests timeline data. Inactive consumers read cached data without request demand.
Discovery uses ordinary PR tabs and their existing once-per-workspace close opt-out.

## Side pane

`packages/app/src/workspace-tabs/open-beside.ts` owns content opened beside the user's work. The
layout store remembers one ordinary pane per workspace. The first side open creates a full-height
right split around the workspace root; later side opens reuse it. Only the `split-panes` layout
mode opens beside. Compact and single-pane layouts (touch tablets) open the same target in the main
pane, so callers never check whether splits render.

Removing a pane clears its remembered id; a later side open creates a new pane. The last visible
ordinary pane stays when its final tab closes and shows the New launcher. An empty workspace does
not automatically create an agent draft tab; choosing Agent opens one. Explorer cannot replace the
workspace canvas, even when visible. Restoring a saved layout enforces the same rule while preserving Explorer and saved
tab content. There is no hidden side-pane lifecycle.

Placement intent still controls existing tabs:

| Mode      | New target                  | Existing target                   |
| --------- | --------------------------- | --------------------------------- |
| `pane`    | opens in the requested pane | moves to the requested pane       |
| `prefer`  | opens in the requested pane | stays where the user placed it    |
| `focused` | opens in the focused pane   | focuses it where it already lives |
| `ambient` | opens in a compatible pane  | focuses it where it already lives |

Explicit **Open to Side** uses `pane`. Implicit opens use `prefer`, so a preference affects only a
new target and never yanks an existing tab out of a user-selected pane.

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

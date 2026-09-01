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

Files and Changes are the Explorer defaults and its singleton navigation views. Other compatible
tabs, including agents, terminals, files, and diffs, can move between Explorer and main panes.
Keep panel implementations independent of either shell. `WorkspacePanelHost` owns mounting and
retention, while each shell owns its tabs, focus, dragging, resizing, and shortcuts.

### Adding a tab target kind

A new `WorkspaceTabTarget` kind touches several lists, and only two of them fail the build. The
manifest in `panels/panel-manifest.ts` is exhaustive, and so is `buildDeterministicWorkspaceTabId`.
Everything else fails at runtime or not at all:

- `WorkspaceTabTargetStorageSchema` in `stores/workspace-layout-store.ts` is a separate strict union
  with no compile-time link to the TypeScript one. A missing branch fails `safeParse` for the entire
  persisted layout, so every workspace loses every tab on restart — not just the new kind.
- `normalizeWorkspaceTabTarget` in `workspace-tabs/identity.ts` returns `null` by default, which
  removes the tab from the layout with no error.
- `secondaryWorkspaceTabTargetsEqual` returns `false` by default, so `intent: "reveal"` opens a
  duplicate instead of focusing the tab that already exists.
- The fallback-label chains in `screens/workspace/workspace-screen.tsx` end at `labels.agent`.
- `panels/register-panels.ts` is a map, not a record. A missing `registerPanel` call throws when the
  tab is first opened.

Add the kind to `isEphemeralTab` (`stores/workspace-layout-actions.ts`) only if it pins something a
rebase can invalidate, the way `commit_diff` pins a sha. Kinds without an identity argument restore
like `files` and `changes_tree`.

## Explorer sidebar

`packages/app/src/workspace-tabs/explorer-sidebar.ts` owns show, hide, toggle, and view selection.
On desktop, the shell is rendered outside the workspace split canvas so it divides the full
workspace, including the header. It has its own persisted width and resize handle. Main-pane splits
never read or modify that width.

`packages/app/src/workspace-tabs/open-supporting-view.ts` owns semantic Changes and pull-request
opens. Compact and wide native layouts select the matching Explorer tab. Desktop Changes opens
follow the shared diff preference. Desktop pull requests use their Main panel, On the side, or
Explorer sidebar setting. Callers request the content and never choose the shell.
The composer Changes pill is a two-stage desktop action: it first reveals Explorer on Changes, then
routes later presses to the working diff through the shared diff preference.

The persisted layout still contains the Explorer pane so tabs survive reloads. The renderer removes
that pane from the workspace split tree and docks it separately. Persisted identifiers retain the
literal `"explorer"` pane id and `explorerPaneIdByWorkspace` key for compatibility.

The tab rail has no inline add or close controls. Its context menu opens a New Tab launcher and
toggles the singleton Files and Changes views. Individual tab menus close instances or move
compatible tabs to main. Explorer tabs can be reordered, but the dock cannot be split. Selecting
an Explorer tab does not change workspace focus.

Cmd+E shows or hides Explorer without changing its selected view. Compact layouts use the combined
full-screen Explorer overlay for Changes, Files, and pull requests, and close it after a file opens.
Wide native layouts without pane splits use the same combined content in a resizable inline dock;
opening a file leaves that dock visible. Both presentations keep their selection in the panel store
and reuse the layout store's per-workspace Explorer width. They do not create a second Explorer
lifecycle.

## Side pane

`packages/app/src/workspace-tabs/open-beside.ts` owns content opened beside the user's work. The
layout store remembers one ordinary pane per workspace. The first side open creates a full-height
right split around the workspace root; later side opens reuse it.

Closing the pane or moving away its final tab removes it normally and clears the remembered id. A
later side open creates a new pane. There is no hidden side-pane lifecycle.

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

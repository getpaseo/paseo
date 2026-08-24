# Side panel

The companion surface beside the user's work: Changes, Files, the pull request, and
anything an agent asks to show alongside its output.

Everything that opens, reveals, hides, or asks about it goes through
`packages/app/src/workspace-tabs/side-panel.ts`. Nothing else branches on which
surface the current layout uses.

Desktop panels declare `supportedHosts` in the panel registry. The launcher filters by the
destination host, and layout moves reject unsupported destinations. The Side panel accepts Files,
Changes, pull requests, and terminals. Files and Changes cannot move into the main workspace.

## Three renderings, two facts

| Layout                 | Rendering                                         |
| ---------------------- | ------------------------------------------------- |
| compact                | slide-over overlay, owned by the panel store      |
| non-compact + splits   | full-height right dock, owned by the layout store |
| non-compact, no splits | ordinary tabs in the focused pane                 |

The third case is the one that bites. A native tablet renders one pane at a time and
the tab row only lists the focused pane's tabs, so anything routed into a separate
side panel pane there disappears with no way back.

## Placement

Where a tab lands is an intent the caller declares, not something the store infers
from a `paneId` that happens to be in scope. `WorkspaceTabPlacement`
(`packages/app/src/stores/workspace-layout-actions.ts`) has four modes, and the
difference between them only shows up when the tab is already open somewhere:

| Mode      | New tab           | Tab already open             |
| --------- | ----------------- | ---------------------------- |
| `pane`    | opens in the pane | **moves** to the pane        |
| `prefer`  | opens in the pane | stays where the user left it |
| `focused` | focused pane      | focuses it in place          |
| `ambient` | focused pane      | focuses it in place          |

`pane` is a pane-local affordance — that pane's `+` menu, its empty-state launcher.
The user is placing the tab and expects it to arrive.

`prefer` is an implicit supporting open — an agent's file link or a failed workspace
setup. It has an opinion about new tabs only. Yanking a tab out of the pane the user
deliberately moved it to is the failure this mode exists to prevent.

`ambient` differs from `focused` in one rule: reconciliation opens tabs with nobody
behind the click, and the side panel can hold focus from an earlier reveal, so an
ambient open of something the user works _in_ (an agent, a terminal, a browser) is
pushed out of the side panel. A `focused` open honours the focused pane whatever it
is, because the user is standing in it.

Deduplication lives in `openTabInLayoutFocused`, so it obeys the placement intent for
every caller. Do not re-place a tab after opening it.

## Lifecycle

The side panel is a pane in the layout model, but desktop renders it as a full-height dock outside
the main split canvas. It divides the workspace shell above the main header and still shares the
tab drag context with the main panes. Its dedicated tab rail uses icon-only tabs with no close or
new-tab controls. Use the rail's context menu to choose its tabs. Its left edge uses the same
mouse-and-touch resize handle as workspace splits.

- **Close pane** on the side panel **hides** it; its tabs are waiting on the next reveal.
- **Close pane** on any other pane **removes** it.
- Closing the Side panel's final tab hides the pane. Revealing it returns the empty launcher.
  This is close-only: claiming or dragging that tab to another pane leaves the empty Side panel
  visible.
- Nothing takes the last visible pane away. `closePane` will not remove it, and
  neither `closePane` nor `hideSidePanel` will hide it — including the header toggle
  reaching `hideSidePanel` after every other pane is gone. The gate is one check in
  `setPaneHiddenInLayout`; do not add a second one upstream.

`closePane` in the layout store owns that distinction. React renders the button and
does not decide what it means.

Dragging a pane's last tab into another pane collapses the source pane — except the
side panel, which the user summons and expects to find again, split size and all.

## Explorer toggle

The header toggle and Cmd+E hide the explorer when it is visible. Revealing it selects Changes tree
for a Git checkout and Files tree otherwise. Tree selections open content in the last-focused main
pane; an unmodified File or Working diff tab is reused there.

Detecting a pull request still opens nothing. A failed workspace setup adds a background tab to the
main pane. Running and successful setup never seed tabs.

## Routing preference

**Settings → General → Open supporting tabs in the Side panel**, on by default,
persisted in client app settings as `openSupportingTabsInSidePanel`. Off means new
supporting tabs land in the focused pane instead. Mobile ignores it. Explicit actions
— the header toggle, a pane's `+` menu, the empty-state launcher — are never subject
to it. The Changes keyboard shortcut and the diff-stat pill above an agent composer are
supporting opens: they follow the preference and focus an existing Changes tab wherever
the user left it. When Changes is already visible in the Side panel, the diff-stat pill
hides the panel without closing the tab. A different visible Side panel tab switches to
Changes instead.

## The name

The product surface is the **Side panel**. **File Explorer** is still the name of the
Files view inside it. Persisted identifiers keep their pre-rename spelling: the pane
id is the literal string `"explorer"` (`SIDE_PANEL_PANE_ID`) and the persisted layout
key is `explorerPaneIdByWorkspace`. The persisted state schema is strict, so renaming
either would fail every saved blob and wipe the layout it describes.

# Logical workspaces in the native Paseo sidebar

## Scope and immutable delivery constraints

This design targets the current upstream Paseo desktop and plugin APIs.

Desktop installations must keep the official Developer ID/notarized application. This branch is an upstream
candidate only: it must not be deployed as a custom Electron application or switched live. The
runtime feature is delivered by a reloadable plugin after the required seam lands in an official
signed Paseo release.

## Why the v0.5.1 plugin API cannot implement this alone

The exact `v0.5.1` API has four hard gaps:

1. `addSidebarItem` contributes only one compact top-level row routed to a plugin surface. It
   cannot contribute to or project the native Project/Workspace tree.
2. A plugin surface is bound to one selected host. Equal installations are coalesced behind a
   host picker, and plugin code cannot address another host at the same time.
3. Plugin navigation is limited to registered plugin surfaces and panels. The runtime does not
   expose Expo Router, the native workspace navigation action, or the workspace-layout store.
4. `PluginWorkspaceSnapshot` omits workspace labels and is available only inside an already-open
   workspace panel. It cannot drive a cross-host sidebar projection.

A plugin could duplicate workspaces and history inside a custom surface, but it could not replace
the native rows or open the selected native workspace. That would create a second sidebar instead
of the requested native hierarchy.

## Minimal upstream seam

Add one declarative client contribution:

```ts
interface PluginSidebarWorkspaceGroupingContribution {
  id: string;
  logicalWorkspaceRefLabelPrefix: string;
  defaultPlacementLabel: string;
  retainedHistoryBindings?: readonly {
    workspaceId: string;
    physicalWorkspaceRef: string;
    logicalWorkspaceRef: string;
  }[];
}

interface PluginContext {
  addSidebarWorkspaceGrouping(contribution: PluginSidebarWorkspaceGroupingContribution): void;
}
```

The optional bindings are host-local exact native IDs generated from the layout history census;
core adds the contributing host's `serverId`. They are not inferred from paths or titles and are
not written back as labels. The contribution contains no UI, router, store, or callback access.
Core Paseo keeps ownership of project grouping, native workspace identity, selection, status,
history access, ordering, and navigation. The plugin only declares how reserved labels encode
group membership and the default placement. Equal plugin/contribution IDs on several hosts form
one namespace; a contribution only applies to workspaces on a host where that plugin is installed.

This is the smallest update-safe seam: custom policy stays in a reloadable plugin, while native
navigation remains inside the signed app. Removing or failing the plugin returns every physical
workspace to the unmodified native list.

## Reserved label contract

Version 1 reserves the case-insensitive prefix `paseo:reserved:`. Reserved labels are never shown
as user chips, manager rows, picker rows, or sidebar filter options.

The logical-workspace plugin declares these exact values:

```text
paseo:reserved:v1:logical-workspace-ref=<logical_workspace_ref>
paseo:reserved:v1:placement-role=default
```

`logical_workspace_ref` must match `[a-z0-9][a-z0-9._-]{0,127}` and is directly generable without
escaping. Unknown or malformed
reserved labels stay hidden but do not affect grouping. A default-role label without a valid
logical ref is ignored. Core never infers groups from titles, paths, hosts, Git remotes, or user
labels.

## Native projection and data flow

The existing `projectKey` pipeline remains unchanged and runs first:

```text
host Project descriptors -> native projectKey grouping -> SidebarProjectEntry
workspace labels + plugin declaration -> logical rows within that one native Project
```

Grouping is scoped to one native Project and namespaced by plugin ID plus contribution ID. Thus an
identical logical ref cannot merge Cars with Dom, and native Projects never become logical
workspaces.

A managed logical row owns every matching live physical placement. It shows one aggregate status and
is selected whenever any member is the active route. Expanding it reveals the unchanged physical
workspace rows, including host badges, context menus, and their separate agent/session histories.
No registry row is archived, hidden from storage, renamed, or rewritten by the projection.

A `retainedHistoryBinding` is the deliberate exception to live placement membership. Its native
workspace remains live in storage, but is not a placement, target, default candidate, logical
status input, Project-header status input, pinned row, shortcut, or Status-mode row. It is exposed
only as `retainedAgentSources: {serverId, workspaceId}[]`. Core reads that source's native root
sessions with the existing workspace-agent visibility policy and renders compact agent links below
the logical row. Clicking one navigates directly to the exact native agent. Thus running and older
sessions remain reachable without recreating the orphan as a third workspace row.

Unmanaged workspaces keep the exact v0.5.1 row. In Status grouping ordinary live placements keep
the exact v0.5.1 rows; successfully bound retained-history sources stay hidden there as well.
Logical grouping otherwise changes only Project mode.

## Deterministic target selection

Pressing a logical row selects exactly one physical workspace in this order:

1. the member already active in the current route;
2. a member marked default;
3. any remaining member.

Within steps 2 and 3, prefer the most recent non-null `statusEnteredAt`, then compare `serverId`,
then `workspaceId`. This handles several live native placement records without depending on
arrival order. Multiple defaults are tolerated and remain
deterministic; the inventory generator should still emit one default physical placement per
logical ref.

The logical status is the existing most-urgent aggregate across all hydrated members. The row
title comes from the selected target (`title`, then native name), so the declared default controls
display when placements have drifted titles.

## Native creation flow

When exactly one compatible grouping contribution applies to the selected host, the native New
Workspace screen shows a logical-workspace picker. It can create a new logical workspace or attach
the new physical placement to an existing logical ref in the selected native Project. The reserved
labels are part of the workspace-create request and are persisted in the initial registry record;
there is no unlabeled intermediate row that can flash as a duplicate in the sidebar.

A logical row offers `Add host` for the first Project host that does not already have a placement
and can create one (Git worktree support or workspace multiplicity). The action opens the existing
New Workspace screen on that host and preselects the logical ref. It does not invent a native
Project placement: cross-host Project availability still comes from Paseo's native `projectKey`
grouping, most commonly the same Git remote checked out on several hosts.

Invalid route refs, an ambiguous grouping contribution, or a host without creation support fail
open: no reserved labels are written and the ordinary native creation flow remains available.

## Pinning, filtering, failures, and rollback

Managed physical members remain inside their logical row instead of being hoisted individually to
Pinned; logical pinning is intentionally not added in this slice. Their original `pinnedAt` data is
not changed. Expanding the logical row still exposes each native member.

User label filtering happens on physical assignments first; a logical row survives when at least
one member matches. Reserved labels cannot be selected as filters. Host and Project filters retain
their current semantics.

Invalid plugin declarations are rejected during bundle evaluation. A resolver error, missing
plugin, unsupported host, invalid ref, or absent labels fails open to native physical rows. The
rollback is disabling/removing the plugin; no workspace registry migration is required.

## Official desktop delivery boundary

The client plugin cannot inject or replace this native projection in an unmodified v0.5.1 app.
The changed renderer is the Expo output `packages/app/dist`, packaged by
`packages/desktop/electron-builder.yml` as the signed app resource
`Paseo.app/Contents/Resources/app-dist`; packaged `main.ts` loads that exact directory through
`process.resourcesPath`. Replacing it locally changes a code-signed bundle resource and is not an
acceptable update path for Developer ID, notarization, or preserved macOS TCC identity.

Therefore this branch is only an upstream candidate. The seam must ship through Paseo's official
build/sign/notarize pipeline, after which existing signed apps can install the official update
and a reloadable layout plugin can activate the feature. There is no custom desktop build,
resource replacement, or live switch in this work.

## Verification boundary

Tests must prove the reserved grammar and hiding, plugin contribution collection, preservation of
native `projectKey` grouping, lossless physical membership, deterministic target selection,
aggregate status, active selection, retained root-agent links, native-ID deduplication, and
fail-open behavior. Run focused
RED/GREEN tests first, then all app tests, plugin/protocol typechecks, and the full app typecheck.
No desktop package is produced or installed by this work.

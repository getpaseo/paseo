# Workspace organizer

The workspace organizer is a client-side presentation of workspaces. It does not change a
workspace's `projectId`, directory, lifecycle, or daemon ownership.

## Scope

Start with named sections inside one project. A section has a stable local ID, a name, and an
ordered list of workspace keys. The unsectioned remainder is a first-class section. Workspace
placement is per device, alongside the existing sidebar order and collapse preferences.

Project mode renders the sections. Status mode remains a derived view and ignores them. Pinned
workspaces remain in Pinned while retaining their section placement for when they are unpinned.

Create, rename, collapse, reorder, and delete sections. Move a workspace through its existing row
menu on every platform. Desktop/web drag between sections is a later enhancement: native list drag
does not support cross-list moves.

## Persistence boundary

`workspaceOrderByProject` already scopes display order by `projectViewKey`; sections should use
the same key and workspace key shape. Do not add a group field to workspace records: project
membership is server-owned and stable, while a user-defined section is an empty-capable,
order-bearing display object.

This makes the first release local to each client. If sections must synchronize across devices or
daemons, add a revisioned sidebar-layout document and protocol capability. Do not fan out client
preferences or infer ownership from members.

## Prior art

PR [#2635](https://github.com/getpaseo/paseo/pull/2635), opened 2026-07-30 and closed unmerged on
2026-08-11, explored replicated project and workspace groups. Its useful constraints are retained:
groups must be entities to survive empty and carry order; disconnected keys must stay stored; and
cross-list drag needs a menu path on native. It was superseded by the labels direction, not shipped
code. Shipped labels and filters are complementary, not an implementation of manual sections.

The plugin API contributes a top-level sidebar item and its own surface. It cannot insert a section
or row into the native workspace list, so this feature belongs in the app source.

## Verification

Keep the no-section projection byte-for-byte equivalent to today's project view. Add deterministic
tests for section edits, persisted-state normalization, collapse, pinned precedence, filtered
reordering, empty-section retention, and moving a workspace through the menu. Preview project mode
on desktop/web and compact native; exercise the menu move on native. Cross-device replication is
out of scope until a server-backed layout exists.

## Implementation checkpoint — 2026-09-11

The first implementation stores sections in the existing local sidebar-order record and renders
them only in Project mode. The unsectioned remainder now has the same persisted collapse behavior
as named sections. The section menu enters a temporary select mode; selected workspaces move
together through one section picker, then selection clears. Desktop Shift-click toggles a workspace
pin without opening it. The isolated Electron preview used this worktree's `.dev/paseo-home` and
port `6768`; it did not touch the active daemon on port `6767` or installed app data. Focused app
tests cover normalization, section lifecycle, collapse persistence, bulk movement, pinned and
filtered projection, shortcuts, and the no-section path. `npm run typecheck` and `npm run lint`
pass.

The source remains native-safe, but this checkpoint is desktop/web validation only. It does not
ship the feature to the App Store or synchronize layouts to an iOS device; official iOS support
requires upstream acceptance and a release.

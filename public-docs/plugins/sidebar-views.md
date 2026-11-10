# Build a sidebar view

A sidebar view replaces the content between Paseo's header and footer. You receive theme tokens,
active entity refs and navigation methods, then render your own React Native UI. Install the
[sidebar-views example](https://github.com/getpaseo/paseo/tree/main/plugin-examples/sidebar-views)
to try projects, task-based agents, nested agents and label folders.

## Register a view

```tsx
import type {
  PluginClientContext,
  PluginSidebarViewProps,
  WorkspaceRef,
} from "@getpaseo/plugin/client";
import { useWorkspaces, useWorkspace } from "@getpaseo/plugin/client";
import { Pressable, ScrollView, Text } from "react-native";

function WorkspaceRow({
  reference,
  navigation,
  theme,
}: {
  reference: WorkspaceRef;
  navigation: PluginSidebarViewProps["navigation"];
  theme: PluginSidebarViewProps["theme"];
}) {
  const workspace = useWorkspace(reference);
  if (!workspace) return null;
  return (
    <Pressable onPress={() => navigation.openWorkspace(reference)}>
      <Text style={{ color: theme.colors.foreground }}>{workspace.title ?? workspace.name}</Text>
    </Pressable>
  );
}
function Workspaces({ navigation, theme }: PluginSidebarViewProps) {
  const workspaces = useWorkspaces({ orderBy: "name" });
  return (
    <ScrollView>
      {workspaces.map((reference) => (
        <WorkspaceRow
          key={reference.key}
          reference={reference}
          navigation={navigation}
          theme={theme}
        />
      ))}
    </ScrollView>
  );
}
export default function contribute(client: PluginClientContext) {
  return client.addSidebarView({ id: "workspaces", title: "My workspaces", Component: Workspaces });
}
```

Registration adds an option under **Settings > Sidebar > Sidebar view**. The user selects it;
installing the plugin leaves the current view selected. Header navigation, plugin header items,
the callout and footer stay visible. A missing or disabled view falls back to Default view.
A view that throws shows a placeholder with **Use default view**.

The view renders once across connected hosts. `active.workspace` and `active.agent` are refs or
`null`. Use `navigation.openWorkspace`, `openAgent`, `openTerminal` or `openProject` with a ref;
`openProject` starts the new workspace flow. Navigation closes the compact sidebar. Call
`dismiss()` after navigation you implement yourself.

## Query refs, read each row

`useWorkspaces`, `useAgents`, `useProjects` and `useTerminals` return immutable arrays of refs.
A ref has `kind`, `hostId`, `id` and a cross-host `key`. The same entity keeps the same frozen
ref for the app session. Pass it to `useWorkspace`, `useAgent`, `useProject` or `useTerminal`
inside the row. A deleted entity returns `null`.

```tsx
const projects = useProjects({ orderBy: "displayName" }); // Includes empty projects.
const agents = useAgents({
  hosts: [hostId],
  where: (agent) => agent.workspace.key === workspaceRef.key,
  orderBy: ["lastActivityAt", "desc"],
});
const folders = useWorkspaces({
  groupBy: (workspace) => workspace.labels, // A workspace can appear in several folders.
});
```

Every query accepts `hosts` (server IDs), `where`, `orderBy` and `groupBy`. Omit `hosts` to query
every connected host. `orderBy` accepts a snapshot field, `[field, "asc" | "desc"]`, or a
comparator. Null fields sort last. Keep comparators cheap; they run when data changes.
`groupBy` returns a string, `{ key, title?, color? }`, or an array of these. Grouped results have
`key`, `title`, `color` and `items`. Groups follow first appearance after sorting; duplicate keys
use the first title. An empty array puts an item in no group.

An unchanged ref sequence keeps its array identity. Groups keep their identity when their
metadata and item sequence stay the same. A workspace status change updates that row without
rendering the list again. A grouping change updates the affected groups. Inline query objects
and functions work without managing subscriptions yourself.

Entity hooks accept a selector and optional equality function:

```tsx
const workspace = useWorkspace(ref); // Interned snapshot, compared by identity.
const name = useWorkspace(ref, (item) => ({ title: item.title })); // Shallow equality.
const selected = useWorkspace(ref, selector, equals);
```

Without a selector, custom equality receives snapshots. With a selector, it receives selections.
Existing workspace panels can continue passing a host-local string ID to `useWorkspace` and
`useAgent`. Prefer refs for a view spanning hosts. `useHosts()` retains its existing
`serverId`, `label` and connection `status` fields.

Workspace snapshots include `project`, `pinnedAt`, `labels`, `background`, `branch`,
`lastPromptAt`, `parentAgent` and `createdAt` (null on older hosts). Use `indicator` and the
localized `indicatorLabel` to display the status Paseo shows. `status` remains the raw daemon
status. Agent snapshots include their workspace and parent refs. Project snapshots provide
`displayName`, `rootPath`, `kind` and `iconRevision`.

## List terminals

The terminals example selects a host, lists its terminals, focuses a terminal tab and closes a
terminal through its handle. `useTerminals({ hosts: [hostId] })` requires a host advertising
`terminalCollection`. A terminal reader throws an update-host error for an unsupported queried
host; other entity hooks continue working. Keep host selection outside an error boundary so the
user can select another host. Omit `hosts` to require the capability on every connected host.

Terminal snapshots contain `workspace`, `title`, `isScript` and `createdAt`. A terminal kept alive
by a worker from before timestamp tracking has `createdAt: null`. Script ownership follows
workspace script runtime entries. The host observation follows terminal creation, closure, title
changes and reconnects, and releases when its last plugin subscriber leaves.

## Act on a ref

`usePaseo()` routes ref-based actions to the ref's host:

```tsx
const paseo = usePaseo();
await paseo.workspaces.ref(workspaceRef).setPinned(true);
await paseo.workspaces.ref(workspaceRef).setLabel("Later", { assigned: true });
await paseo.workspaces.ref(workspaceRef).setLabel("Inbox", { assigned: false });
paseo.projects.ref(projectRef).open();
await paseo.projects.ref(projectRef).createWorkspace();
paseo.terminals.ref(terminalRef).focus();
await paseo.terminals.ref(terminalRef).kill();
```

Workspace and agent handles retain their existing methods. Assigning a new label creates it;
assigning an existing label keeps its color. The label-folder example adds the destination
before removing the source, so a failed assignment preserves the original folder. It owns the
move gesture and error display.

## Keep layout choices on the device

Define a [settings document](reference.md#settings-screens) with `scope: "device"` for collapsed
folders or manual order. `useSettings` reads and writes it through the same revision-based API
as host settings. Device documents belong to the installation and settings ID, persist across
app launches, and are shared across that installation's client surfaces. They are not synced
to other devices. Use `scope: "host"` for data clients should share through the daemon.

## Match the app's density

Render with React Native primitives. The SDK exports no sidebar-view rows, sections, lists,
badges or drag helpers. The existing header/footer item kit is a separate surface.

For a dense row use a minimum height of 28, horizontal padding of 12, a 12-point primary label
with 16-point line height and an 11-point secondary label. Use these supplied tokens:

| Row element                      | Theme token              |
| -------------------------------- | ------------------------ |
| Primary label                    | `colors.foreground`      |
| Secondary label, section heading | `colors.foregroundMuted` |
| Selected row fill                | `colors.surface2`        |
| Separator                        | `colors.border`          |
| Action or focus accent           | `colors.accent`          |
| Success indicator                | `colors.statusSuccess`   |
| Needs input indicator            | `colors.statusWarning`   |
| Failure indicator                | `colors.statusDanger`    |

Give pressable rows an accessible label and show controls on touch layouts. The examples use
only plugin-owned components and the tokens passed to the view.

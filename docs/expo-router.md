# Expo Router

Paseo's mobile route tree is fragile because Expo Router and React Navigation do
not fail loudly when a nested native route is mounted under the wrong layout. The
usual symptom is a white or blank native screen with no JavaScript crash.

Read this before changing `packages/app/src/app`, startup routing, remembered
workspace restore, or active workspace selection.

## Ownership

Each layout owns only the routes directly inside its directory.

- The root layout registers `h/[serverId]`.
- The root layout does not register host leaf routes such as
  `h/[serverId]/workspace/[workspaceId]`, `h/[serverId]/open-project`, or
  `h/[serverId]/index`.
- `packages/app/src/app/h/[serverId]/_layout.tsx` owns the host leaves with
  relative screen names: `index`, `workspace/[workspaceId]/index`,
  `agent/[agentId]`, `sessions`, `open-project`, and `settings`.

Expo Router warns with `[Layout children]: No route named ...` when a layout
registers grandchildren. Treat that warning as a route-tree bug. On native, that
shape can leave a nested index route mounted without its local dynamic params and
render a blank screen.

## Startup

The root `/` route chooses a host boundary. It does not jump directly into a host
leaf.

- Good: `/` -> `/h/[serverId]`
- Bad: `/` -> `/h/[serverId]/workspace/[workspaceId]`

`/h/[serverId]` is the host home route. The host index restores the last
remembered workspace for that host after the remembered selection has hydrated
and the workspace has not been proven missing. If there is no restorable
workspace, it goes to global `/open-project`.

This restore is based on the last navigated workspace, not current connection
status. Do not redirect to another online host just because the remembered host
is still connecting or offline; the workspace screen owns that offline/loading
state.

This split is deliberate. The host layout must mount first so native local
dynamic params exist before any nested workspace leaf is selected.

## App-Wide Route Hops

When app-wide routes such as `/new`, `/settings`, or `/sessions` navigate back
into a host workspace, use `navigateToWorkspace()`. Do not make the caller
branch on its current route.

Pass only `serverId` and `workspaceId` for normal attention-aware navigation.
When the action names a specific tab, pass it as `target`; that explicit choice
is authoritative. Callers should not choose between separate route and tab
navigation APIs.

The root stack owns `h/[serverId]`; the host stack owns
`workspace/[workspaceId]/index`. Repeated global-route hops must `POP_TO` the
root host route and pass the nested workspace screen when a host route is
already mounted, or Expo Router can append extra hidden workspace deck entries.
The workspace navigation helper inspects the mounted navigation state to make
that decision; if no host route is mounted yet, it falls back to ordinary route
navigation.

Those hidden entries are not harmless: composer floating panels can measure
against the wrong deck and disappear offscreen.

Hidden host routes may keep their local params while an app-wide route is
foregrounded. Active-workspace observers must prefer the current pathname and
only use local param fallback during cold mount (`/` or empty pathname), or a
hidden workspace can overwrite the remembered workspace before Settings or
History returns.

## Params

Required dynamic params belong to the matched route.

Do not paper over missing required params by reading global params in the leaf.
If `useLocalSearchParams()` misses a required param, fix layout ownership or the
startup route shape.

Use the host route context for host-owned leaves that need the host id after
`h/[serverId]/_layout.tsx` has matched. Do not make a leaf recover from an
unmatched tree by guessing from global state.

## App Directory

Keep non-route modules out of `src/app`. Expo Router treats ordinary `.ts` and
`.tsx` files there as routes, which produces `missing the required default
export` warnings and pollutes the route tree.

Put shared route policy in `src/navigation`, `src/utils`, stores, or another
non-route directory.

## Native Stack

Keep workspace identity and retention outside native-stack `getId` and
`dangerouslySingular`. Expo Router maps `dangerouslySingular` to React
Navigation `getId`, and `getId` has broken Android native-stack/Fabric by
reordering an already-mounted workspace screen.

Use `ThemedStack` from `packages/app/src/navigation/themed-stack.tsx` for every
Expo Router stack. React Navigation otherwise paints each native stack screen
with its light default background. A screen-level wrapper can hide that surface
while settled, but Android may expose it for one frame when navigation crosses
from a nested stack to its parent stack. This is especially visible when an
app-wide route such as `/new` opens from a dark workspace.

Do not read the active theme with `useUnistyles()` in a layout to build
`screenOptions`. `ThemedStack` keeps that third-party prop theme-reactive through
a small `withUnistyles` boundary without subscribing the route tree itself to
every Unistyles runtime update.

## Regression Shape

Pure helper tests are useful but not enough. The failure mode here is native
route-tree state, so a real regression should launch native with seeded persisted
state:

1. Seed `paseo:last-workspace-route-selection` with a valid
   `{ serverId, workspaceId }`.
2. Launch the native app cold.
3. Assert a real screen is visible, not the blank tree.
4. Assert no `[Layout children]` warning appears.

The pure policy tests should still enforce the boundary split:

- root startup with a saved workspace returns `/h/[serverId]`;
- host index with the same saved workspace returns
  `/h/[serverId]/workspace/[workspaceId]`;
- host index with no restorable workspace returns `/open-project`.

## Checklist

Before landing route changes:

- [ ] Did you change `packages/app/src/app`? Re-read this file.
- [ ] Did you touch remembered workspace restore? Keep root on `/h/[serverId]`.
- [ ] Did a route return to a workspace? Use `navigateToWorkspace()` and pass a
      `target` when the action names a specific tab.
- [ ] Did you add a route? Register it in the layout that directly owns it.
- [ ] Did `useLocalSearchParams()` lose a required param? Fix the route tree.
- [ ] Did native show a blank screen without a crash? Suspect route ownership
      before stores, themes, or rendering.

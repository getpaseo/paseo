import type { PluginWorkspaceStatusRendererProps } from "@getpaseo/plugin/client";
import type { WorkspaceActivity, WorkspaceStatusDetails } from "@getpaseo/protocol/messages";
import type { InstalledPlugin } from "@/plugins/types";

const detailsCache = new WeakMap<
  WorkspaceStatusDetails,
  NonNullable<PluginWorkspaceStatusRendererProps["statusDetails"]>
>();
const activitiesCache = new WeakMap<
  readonly WorkspaceActivity[],
  NonNullable<PluginWorkspaceStatusRendererProps["activities"]>
>();

/** One immutable projection per snapshot, shared by all rows observing that workspace. */
export function projectWorkspaceStatusDetails(
  details: WorkspaceStatusDetails | undefined,
): PluginWorkspaceStatusRendererProps["statusDetails"] {
  // COMPAT(workspaceStatusDetails): old hosts have no inventory; remove after 2027-04-28.
  if (!details) return null;
  let projected = detailsCache.get(details);
  if (!projected) {
    projected = Object.freeze({
      nativeStatus: details.nativeStatus,
      rootStatus: details.rootStatus,
      roots: Object.freeze(details.roots.map((root) => Object.freeze({ ...root }))),
      subordinates: Object.freeze(details.subordinates.map((item) => Object.freeze({ ...item }))),
    });
    detailsCache.set(details, projected);
  }
  return projected;
}

export function projectWorkspaceStatusActivities(
  activities: readonly WorkspaceActivity[] | undefined,
): PluginWorkspaceStatusRendererProps["activities"] {
  // COMPAT(pluginWorkspaceActivities): omission means unavailable; remove after 2027-04-27.
  if (!activities) return null;
  let projected = activitiesCache.get(activities);
  if (!projected) {
    projected = Object.freeze(
      activities.map((activity) =>
        Object.freeze({
          ...activity,
          ...(activity.items
            ? { items: Object.freeze(activity.items.map((item) => Object.freeze({ ...item }))) }
            : {}),
        }),
      ),
    );
    activitiesCache.set(activities, projected);
  }
  return projected;
}

export function selectWorkspaceStatusRenderer(
  plugins: readonly InstalledPlugin[],
  serverId: string,
) {
  return (
    plugins
      .filter((plugin) => plugin.serverId === serverId)
      .flatMap((plugin) =>
        plugin.workspaceStatusRenderers.map((contribution) => ({ plugin, contribution })),
      )
      .sort(
        (a, b) =>
          a.plugin.id.localeCompare(b.plugin.id) ||
          a.contribution.id.localeCompare(b.contribution.id),
      )[0] ?? null
  );
}

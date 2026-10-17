import type { PluginWorkspaceRowAccessoryProps } from "@getpaseo/plugin/client";
import AsyncStorage from "@react-native-async-storage/async-storage";
import React, { useCallback, useMemo, type ComponentType, type ReactNode } from "react";
import { View } from "react-native";
import { useReducedMotion } from "react-native-reanimated";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { z } from "zod";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { ProjectStatusBadge } from "@/components/sidebar/project-leading-visual";
import { useToast } from "@/contexts/toast-context";
import type { SidebarWorkspaceEntry } from "@/hooks/use-sidebar-workspaces-list";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { createValidatedPersistStorage } from "@/storage/validated-persist-storage";
import { densityIconBox } from "@/styles/density";
import type { SidebarSurfaceBackdrop } from "@/styles/surface-backdrop";
import { createPluginClientStateSource } from "./client-state/source";
import { PluginEnvironmentProvider } from "./popover";
import { pluginRegistry, useInstalledPlugins } from "./registry";
import { SurfaceErrorBoundary } from "./surface-error-boundary";
import { getProjectStatusBadgeContent } from "@/utils/project-status-badge-content";
import { toPluginTheme } from "./theme";
import type { EvaluatedWorkspaceRowAccessory, InstalledPlugin } from "./types";
import type { ActiveRowTakeover } from "./workspace-row-takeover";

const SLOT_SIZE = { status: 16, large: 40 } as const;

export interface WorkspaceRowAccessoryTarget {
  plugin: InstalledPlugin;
  accessory: EvaluatedWorkspaceRowAccessory;
}

/** A row has one leading slot: the most recently registered accessory of its host wins. */
export function selectWorkspaceRowAccessory(
  plugins: readonly InstalledPlugin[],
  serverId: string,
): WorkspaceRowAccessoryTarget | null {
  let target: WorkspaceRowAccessoryTarget | null = null;
  for (const plugin of plugins.filter((candidate) => candidate.serverId === serverId)) {
    for (const accessory of plugin.workspaceRowAccessories) {
      if (!target || accessory.sequence > target.accessory.sequence) target = { plugin, accessory };
    }
  }
  return target;
}

function largeAccessoryHosts(plugins: readonly InstalledPlugin[]): string[] {
  const hosts = plugins
    .filter((plugin) => plugin.workspaceRowAccessories.some((entry) => entry.size === "large"))
    .map((plugin) => plugin.serverId);
  return [...new Set(hosts)].sort();
}

/**
 * Titles keep one rail across hosts: one large accessory anywhere widens every row's slot. Rows
 * render before their host's plugins evaluate, so a host remembered from the last launch holds
 * the rail until its catalog is evaluated, instead of the titles jumping when it is.
 */
export function hasLargeWorkspaceRowAccessory(
  plugins: readonly InstalledPlugin[],
  rememberedHosts: readonly string[],
  hasCatalog: (serverId: string) => boolean,
): boolean {
  return (
    largeAccessoryHosts(plugins).length > 0 ||
    rememberedHosts.some((serverId) => !hasCatalog(serverId))
  );
}

const LargeRailMemorySchema = z.object({ hosts: z.array(z.string()) });
const useLargeRailMemory = create<z.infer<typeof LargeRailMemorySchema>>()(
  persist((): z.infer<typeof LargeRailMemorySchema> => ({ hosts: [] }), {
    name: "workspace-row-large-rail",
    version: 1,
    storage: createValidatedPersistStorage(AsyncStorage, LargeRailMemorySchema),
  }),
);

// A remembered host holds the rail only while its catalog may still arrive: at most this long
// in a row (at launch or after a disconnect), so an offline or removed host cannot keep every
// row wide.
const LARGE_RAIL_MEMORY_GRACE_MS = 30_000;
const pendingSince = new Map<string, number>();

/** Hosts to remember: those with a large accessory now, plus remembered ones still loading. */
export function nextLargeRailMemory(
  remembered: readonly string[],
  plugins: readonly InstalledPlugin[],
  hasCatalog: (serverId: string) => boolean,
  pendingFor: (serverId: string) => number,
): string[] {
  const pending = remembered.filter(
    (serverId) => !hasCatalog(serverId) && pendingFor(serverId) < LARGE_RAIL_MEMORY_GRACE_MS,
  );
  return [...new Set([...largeAccessoryHosts(plugins), ...pending])].sort();
}

function updateLargeRailMemory() {
  const now = Date.now();
  const remembered = useLargeRailMemory.getState().hosts;
  for (const serverId of remembered) {
    if (pluginRegistry.hasCatalog(serverId)) pendingSince.delete(serverId);
    else if (!pendingSince.has(serverId)) {
      pendingSince.set(serverId, now);
      setTimeout(updateLargeRailMemory, LARGE_RAIL_MEMORY_GRACE_MS);
    }
  }
  const hosts = nextLargeRailMemory(
    remembered,
    pluginRegistry.getSnapshot(),
    pluginRegistry.hasCatalog,
    (serverId) => now - (pendingSince.get(serverId) ?? now),
  );
  for (const serverId of pendingSince.keys()) {
    if (!hosts.includes(serverId)) pendingSince.delete(serverId);
  }
  if (hosts.join() !== remembered.join()) useLargeRailMemory.setState({ hosts });
}

pluginRegistry.subscribe(updateLargeRailMemory);
useLargeRailMemory.persist.onFinishHydration(updateLargeRailMemory);

export interface WorkspaceRowAccessories {
  target: WorkspaceRowAccessoryTarget | null;
  largeRail: boolean;
}

export function useWorkspaceRowAccessory(serverId: string): WorkspaceRowAccessories {
  const plugins = useInstalledPlugins();
  const rememberedHosts = useLargeRailMemory((memory) => memory.hosts);
  return useMemo(
    () => ({
      target: selectWorkspaceRowAccessory(plugins, serverId),
      largeRail: hasLargeWorkspaceRowAccessory(plugins, rememberedHosts, pluginRegistry.hasCatalog),
    }),
    [plugins, rememberedHosts, serverId],
  );
}

const rowIds = ({ serverId, workspaceId, workspaceKey }: SidebarWorkspaceEntry) => ({
  serverId,
  workspaceId,
  workspaceKey,
});

interface PluginRowSurfaceProps {
  plugin: InstalledPlugin;
  Surface: ComponentType<never>;
  /** What the row shows while the plugin's host is offline or after the plugin throws. */
  children?: ReactNode;
  [prop: string]: unknown;
}

/** A plugin component in a row, inside the plugin's runtime, theme and error boundary. */
function PluginRowSurfaceHost({
  plugin,
  Surface,
  children = null,
  ...props
}: PluginRowSurfaceProps) {
  const client = useHostRuntimeClient(plugin.serverId);
  const toast = useToast();
  const environment = useMemo(
    () =>
      client
        ? { installation: plugin, toast, state: createPluginClientStateSource(plugin.serverId) }
        : null,
    [client, plugin, toast],
  );
  const renderFallback = useCallback(() => children, [children]);
  if (!environment) return children;
  // Plugin components arrive untyped from an evaluated bundle; the contracts type them for plugins.
  const Rendered = Surface as ComponentType<Record<string, unknown>>;
  return (
    <SurfaceErrorBoundary installation={plugin} Surface={Surface} renderError={renderFallback}>
      <PluginEnvironmentProvider environment={environment}>
        <Rendered {...props} />
      </PluginEnvironmentProvider>
    </SurfaceErrorBoundary>
  );
}

const PluginRowSurface = withUnistyles(PluginRowSurfaceHost, (theme) => ({
  theme: toPluginTheme(theme),
}));

type AccessoryFrameProps = PluginWorkspaceRowAccessoryProps & {
  Accessory: ComponentType<PluginWorkspaceRowAccessoryProps>;
  backdrop: SidebarSurfaceBackdrop;
  loading: boolean;
};

// Inside the error boundary, so a throwing accessory gives the row back its native slot.
function AccessoryFrame({ Accessory, backdrop, loading, ...props }: AccessoryFrameProps) {
  // The project icon's corner badge: starting up and working share the running ring.
  const bucket = loading ? "running" : props.statusBucket;
  const badge = getProjectStatusBadgeContent(bucket);
  const slot = (
    <View style={styles.slot(props.size)}>
      <Accessory {...props} />
      {badge ? (
        <ProjectStatusBadge content={badge} statusBucket={bucket} backdrop={backdrop} />
      ) : null}
    </View>
  );
  return props.size > SLOT_SIZE.status ? slot : <View style={styles.statusBox}>{slot}</View>;
}

type WorkspaceRowLeadingProps = Pick<
  AccessoryFrameProps,
  "isHovered" | "isSelected" | "takeover" | "backdrop" | "loading"
> & {
  accessories: WorkspaceRowAccessories;
  workspace: SidebarWorkspaceEntry;
  /** The native leading visual: the row's slot without an accessory, and the fallback with one. */
  children: ReactNode;
};

/** The row's leading slot. Loading, offline and failed accessories keep the same box. */
export function WorkspaceRowLeading({
  accessories: { target, largeRail },
  workspace,
  children,
  ...props
}: WorkspaceRowLeadingProps) {
  const leading = target ? (
    <PluginRowSurface
      plugin={target.plugin}
      Surface={AccessoryFrame}
      Accessory={target.accessory.Component}
      size={SLOT_SIZE[target.accessory.size]}
      {...rowIds(workspace)}
      statusBucket={workspace.statusBucket}
      {...props}
    >
      {children}
    </PluginRowSurface>
  ) : (
    children
  );
  return largeRail ? <View style={styles.largeRail}>{leading}</View> : leading;
}

/** The takeover Overlay: fills the row's main line over the faded title and meta, no pointer. */
export function WorkspaceRowTakeoverLayer({
  takeover,
  accessory,
  workspace,
}: {
  takeover: ActiveRowTakeover;
  accessory: WorkspaceRowAccessoryTarget | null;
  workspace: SidebarWorkspaceEntry;
}) {
  const reducedMotion = useReducedMotion();
  return (
    <View style={styles.layer}>
      <PluginRowSurface
        plugin={takeover.plugin}
        Surface={takeover.Overlay}
        {...rowIds(workspace)}
        reducedMotion={reducedMotion}
        data={takeover.data}
        slotSize={SLOT_SIZE[accessory?.accessory.size ?? "status"]}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  layer: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    overflow: "hidden",
    pointerEvents: "none",
  },
  // Centered on title and meta together.
  largeRail: {
    width: SLOT_SIZE.large,
    height: SLOT_SIZE.large,
    flexShrink: 0,
    alignSelf: "center",
    alignItems: "center",
    justifyContent: "center",
  },
  // The native status box: icon box wide, one title line tall.
  statusBox: {
    width: densityIconBox("md"),
    height: 20,
    flexShrink: 0,
    alignItems: "center",
    justifyContent: "center",
  },
  slot: (size: number) => ({
    position: "relative",
    width: size,
    height: size,
  }),
});

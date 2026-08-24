import type { ComponentType } from "react";
import { getPanelManifest, type PanelManifest } from "@/panels/panel-manifest";
export type { PaneHost } from "@/panels/panel-manifest";
import type { WorkspaceTabTarget } from "@/workspace-tabs/model";
import type { SidebarStateBucket } from "@/utils/sidebar-agent-state";

export interface PanelIconProps {
  size: number;
  color: string;
  strokeWidth?: number;
}

export interface PanelDescriptor {
  label: string;
  subtitle: string;
  tooltip: string;
  titleState: "ready" | "loading";
  icon: ComponentType<PanelIconProps>;
  statusBucket: SidebarStateBucket | null;
}

export interface PanelDescriptorContext {
  serverId: string;
  workspaceId: string;
  tabId: string;
}

export interface PanelRegistration<
  K extends WorkspaceTabTarget["kind"] = WorkspaceTabTarget["kind"],
> extends PanelManifest<K> {
  component: ComponentType;
  useDescriptor(
    target: Extract<WorkspaceTabTarget, { kind: K }>,
    context: PanelDescriptorContext,
  ): PanelDescriptor;
}

type PanelImplementation<K extends WorkspaceTabTarget["kind"]> = Pick<
  PanelRegistration<K>,
  "component" | "useDescriptor"
>;

export function definePanel<K extends WorkspaceTabTarget["kind"]>(
  kind: K,
  implementation: PanelImplementation<K>,
): PanelRegistration<K> {
  return {
    ...getPanelManifest(kind),
    ...implementation,
  };
}

const panelRegistry = new Map<WorkspaceTabTarget["kind"], PanelRegistration>();

export function registerPanel<K extends WorkspaceTabTarget["kind"]>(
  registration: PanelRegistration<K>,
): void {
  panelRegistry.set(registration.kind, registration as unknown as PanelRegistration);
}

export function getPanelRegistration(
  kind: WorkspaceTabTarget["kind"],
): PanelRegistration | undefined {
  return panelRegistry.get(kind);
}

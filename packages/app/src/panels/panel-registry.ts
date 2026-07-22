import type { ComponentType } from "react";
import type { WorkspaceTabTarget } from "@/stores/workspace-tabs-store";
import type { SidebarStateBucket } from "@/utils/sidebar-agent-state";

export interface PanelIconProps {
  size: number;
  color: string;
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
> {
  kind: K;
  component: ComponentType;
  useDescriptor(
    target: Extract<WorkspaceTabTarget, { kind: K }>,
    context: PanelDescriptorContext,
  ): PanelDescriptor;
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

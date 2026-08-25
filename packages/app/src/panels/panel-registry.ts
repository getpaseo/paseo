import type { ComponentType } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import invariant from "tiny-invariant";
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

export interface PanelPresentation {
  label: (t: TFunction) => string;
  subtitle: (t: TFunction) => string;
  tooltip: (t: TFunction) => string;
  icon: ComponentType<PanelIconProps>;
}

export interface PanelRegistration<
  K extends WorkspaceTabTarget["kind"] = WorkspaceTabTarget["kind"],
> extends PanelManifest<K> {
  component: ComponentType;
  presentation?: PanelPresentation;
  useDescriptor(
    target: Extract<WorkspaceTabTarget, { kind: K }>,
    context: PanelDescriptorContext,
  ): PanelDescriptor;
}

type PanelImplementation<K extends WorkspaceTabTarget["kind"]> =
  | {
      component: ComponentType;
      presentation: PanelPresentation;
      useDescriptor?: PanelRegistration<K>["useDescriptor"];
    }
  | {
      component: ComponentType;
      presentation?: never;
      useDescriptor: PanelRegistration<K>["useDescriptor"];
    };

function createStaticDescriptorHook(presentation: PanelPresentation) {
  return function useStaticPanelDescriptor(): PanelDescriptor {
    const { t } = useTranslation();
    return {
      label: presentation.label(t),
      subtitle: presentation.subtitle(t),
      tooltip: presentation.tooltip(t),
      titleState: "ready",
      icon: presentation.icon,
      statusBucket: null,
    };
  };
}

export function definePanel<K extends WorkspaceTabTarget["kind"]>(
  kind: K,
  implementation: PanelImplementation<K>,
): PanelRegistration<K> {
  let useDescriptor = implementation.useDescriptor;
  if (!useDescriptor) {
    invariant(implementation.presentation, `Panel ${kind} requires a presentation`);
    useDescriptor = createStaticDescriptorHook(implementation.presentation);
  }
  return {
    ...getPanelManifest(kind),
    component: implementation.component,
    presentation: implementation.presentation,
    useDescriptor,
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

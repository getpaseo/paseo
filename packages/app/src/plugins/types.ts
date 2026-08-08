import type { ComponentType } from "react";
import type { QueryClient } from "@tanstack/react-query";
import type { PluginRpcContract } from "./sdk";

export interface PluginSurfaceProps {
  theme: Record<string, unknown>;
  host: {
    id: string;
    label: string;
  };
  layout: {
    compact: boolean;
    platform: "ios" | "android" | "web";
  };
}

export interface PluginSurfaceContribution {
  id: string;
  Component: ComponentType<PluginSurfaceProps>;
}

export interface PluginSidebarContribution {
  id: string;
  title: string;
  icon: string;
  surface: string;
}

export interface PluginAttachmentSourceContribution {
  id: string;
  title: string;
  icon: string;
  pickerTitle: string;
  searchPlaceholder: string;
  search: PluginRpcContract;
}

export interface EvaluatedPlugin {
  id: string;
  surfaces: PluginSurfaceContribution[];
  sidebarItems: PluginSidebarContribution[];
  attachmentSources: PluginAttachmentSourceContribution[];
}

export interface InstalledPlugin extends EvaluatedPlugin {
  serverId: string;
  clientBundle: string;
  queryClient: QueryClient;
}

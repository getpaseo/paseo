import type { ComponentType } from "react";
import type { QueryClient } from "@tanstack/react-query";

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

export interface EvaluatedPlugin {
  id: string;
  surfaces: PluginSurfaceContribution[];
  sidebarItems: PluginSidebarContribution[];
}

export interface InstalledPlugin extends EvaluatedPlugin {
  serverId: string;
  clientBundle: string;
  queryClient: QueryClient;
}

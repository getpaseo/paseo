import type { ComponentType } from "react";
import type { ZodType, input as ZodInput, output as ZodOutput } from "zod";
import type { PluginRpcContract } from "./rpc.js";

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

export interface PluginContext {
  handle<InputSchema extends ZodType, OutputSchema extends ZodType>(
    contract: PluginRpcContract<InputSchema, OutputSchema>,
    handler: (
      input: ZodOutput<InputSchema>,
    ) => ZodInput<OutputSchema> | Promise<ZodInput<OutputSchema>>,
  ): void;
  addSurface(id: string, Component: ComponentType<PluginSurfaceProps>): void;
  addSidebarItem(contribution: PluginSidebarContribution): void;
  addAttachmentSource(contribution: PluginAttachmentSourceContribution): void;
}

export type PluginCleanup = () => void;

export type PluginContribution = (plugin: PluginContext) => PluginCleanup;

import type { PluginServerContribution } from "@getpaseo/plugin/server";

export interface InternalPlugin {
  id: string;
  directory: string;
  contribute: PluginServerContribution;
}

export const INTERNAL_PLUGINS: InternalPlugin[] = [];

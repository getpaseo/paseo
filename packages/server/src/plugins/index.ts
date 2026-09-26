import type { PluginServerContribution } from "@getpaseo/plugin/server";
import { fileURLToPath } from "node:url";
import codexUsageSource from "./codex-usage-source/index.server.js";

export interface InternalPlugin {
  id: string;
  directory: string;
  contribute: PluginServerContribution;
}

export const INTERNAL_PLUGINS: InternalPlugin[] = [
  {
    id: "codex-usage-source",
    directory: fileURLToPath(new URL("./codex-usage-source/", import.meta.url)),
    contribute: codexUsageSource,
  },
];

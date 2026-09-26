import type { PluginServerContribution } from "@getpaseo/plugin/server";
import { fileURLToPath } from "node:url";
import codexUsageSource from "./codex-usage-source/index.server.js";
import claudeUsageSource from "./claude-usage-source/index.server.js";
import copilotUsageSource from "./copilot-usage-source/index.server.js";
import cursorUsageSource from "./cursor-usage-source/index.server.js";
import grokUsageSource from "./grok-usage-source/index.server.js";
import kimiUsageSource from "./kimi-usage-source/index.server.js";
import minimaxUsageSource from "./minimax-usage-source/index.server.js";
import zaiUsageSource from "./zai-usage-source/index.server.js";
import opencodeGoUsageSource from "./opencode-go-usage-source/index.server.js";

export interface InternalPlugin {
  id: string;
  directory: string;
  contribute: PluginServerContribution;
}

export const INTERNAL_PLUGINS: InternalPlugin[] = [
  {
    id: "claude-usage-source",
    directory: fileURLToPath(new URL("./claude-usage-source/", import.meta.url)),
    contribute: claudeUsageSource,
  },
  {
    id: "codex-usage-source",
    directory: fileURLToPath(new URL("./codex-usage-source/", import.meta.url)),
    contribute: codexUsageSource,
  },
  {
    id: "copilot-usage-source",
    directory: fileURLToPath(new URL("./copilot-usage-source/", import.meta.url)),
    contribute: copilotUsageSource,
  },
  {
    id: "cursor-usage-source",
    directory: fileURLToPath(new URL("./cursor-usage-source/", import.meta.url)),
    contribute: cursorUsageSource,
  },
  {
    id: "grok-usage-source",
    directory: fileURLToPath(new URL("./grok-usage-source/", import.meta.url)),
    contribute: grokUsageSource,
  },
  {
    id: "kimi-usage-source",
    directory: fileURLToPath(new URL("./kimi-usage-source/", import.meta.url)),
    contribute: kimiUsageSource,
  },
  {
    id: "minimax-usage-source",
    directory: fileURLToPath(new URL("./minimax-usage-source/", import.meta.url)),
    contribute: minimaxUsageSource,
  },
  {
    id: "zai-usage-source",
    directory: fileURLToPath(new URL("./zai-usage-source/", import.meta.url)),
    contribute: zaiUsageSource,
  },
  {
    id: "opencode-go-usage-source",
    directory: fileURLToPath(new URL("./opencode-go-usage-source/", import.meta.url)),
    contribute: opencodeGoUsageSource,
  },
];

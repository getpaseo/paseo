import type { PluginSettings } from "@getpaseo/plugin/server";
import { settingsSchema } from "../shared/settings.js";
import { MuseError } from "./errors.js";

export async function serveArgs(
  settings: PluginSettings<typeof settingsSchema>,
): Promise<string[]> {
  const state = await settings.read();
  if (state.status === "invalid") throw new MuseError("invalidSettings", state.error);
  const { sandbox, network, trustWorkspace } = state.values;
  return [
    "--sandbox-network",
    network,
    ...(sandbox ? [] : ["--disable-sandbox"]),
    ...(trustWorkspace ? ["--trust-workspace"] : []),
  ];
}

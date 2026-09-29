import { z } from "zod";
import type { PluginSettings } from "@getpaseo/plugin/server";
import { MuseError } from "./errors.js";

export const settingsSchema = z.object({
  sandbox: z
    .boolean()
    .default(true)
    .describe("Keep Muse filesystem and network sandboxing enabled"),
  network: z
    .enum(["proxy-only", "restricted", "enabled"])
    .default("proxy-only")
    .describe("Sandbox network access; disabling sandbox forces full network access"),
  trustWorkspace: z
    .boolean()
    .default(false)
    .describe("Let Muse load project-scoped skills and config from the workspace"),
});
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

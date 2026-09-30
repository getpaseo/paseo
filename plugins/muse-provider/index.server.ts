import type { PluginServerContext } from "@getpaseo/plugin/server";
import { createMuseProvider } from "./server/provider.js";

import { museSettings } from "./shared/settings.js";
import { Usage } from "./server/usage.js";

export default function contribute(
  server: Pick<
    PluginServerContext,
    "registerProvider" | "registerSettings" | "registerUsageSource"
  >,
) {
  const settings = server.registerSettings(museSettings);
  const usage = new Usage();
  server.registerUsageSource(usage.registration());
  server.registerProvider(createMuseProvider(settings, usage));
  return () => {};
}

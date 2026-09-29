import type { PluginServerContext } from "@getpaseo/plugin/server";
import { createMuseProvider } from "./server/provider.js";

import { settingsSchema } from "./server/settings.js";
import { Usage } from "./server/usage.js";

export default function contribute(
  server: Pick<
    PluginServerContext,
    "registerProvider" | "registerSettings" | "registerUsageSource"
  >,
) {
  const settings = server.registerSettings({
    id: "muse",
    scope: "host",
    version: 1,
    schema: settingsSchema,
  });
  const usage = new Usage();
  server.registerUsageSource(usage.registration());
  server.registerProvider(createMuseProvider(settings, usage));
  return () => {};
}

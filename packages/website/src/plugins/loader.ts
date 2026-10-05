import { createServerFn } from "@tanstack/react-start";
import { env } from "cloudflare:workers";
import { getWebsiteCacheContext } from "~/cloudflare-cache";
import {
  loadInstallCounts,
  loadRegistryIndex,
  loadRegistryPlugin,
  type RegistryEnvironment,
} from "./published";

function registryBase(): string {
  return (env as RegistryEnvironment).PLUGINS_REGISTRY_URL ?? "https://getpaseo.github.io/plugins";
}
/** Listed plugins in index order, their install counts per window, and the server's clock. */
export const getRegistry = createServerFn({ method: "GET" }).handler(async () => {
  const context = getWebsiteCacheContext();
  const [index, installs] = await Promise.all([
    loadRegistryIndex(registryBase(), context),
    loadInstallCounts(registryBase(), context),
  ]);
  return { plugins: index.plugins, installs, now: new Date().toISOString() };
});
export const getRegistryPlugin = createServerFn({ method: "GET" })
  .validator((id: string) => id)
  .handler(({ data }) => loadRegistryPlugin(registryBase(), data, getWebsiteCacheContext()));

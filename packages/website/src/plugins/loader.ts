import { createServerFn } from "@tanstack/react-start";
import { env } from "cloudflare:workers";
import { getWebsiteCacheContext } from "~/cloudflare-cache";
import { loadRegistryIndex, loadRegistryPlugin, type RegistryEnvironment } from "./published";

function registryBase(): string {
  return (env as RegistryEnvironment).PLUGINS_REGISTRY_URL ?? "https://getpaseo.github.io/plugins";
}
export const getRegistry = createServerFn({ method: "GET" }).handler(() =>
  loadRegistryIndex(registryBase(), getWebsiteCacheContext()),
);
export const getRegistryPlugin = createServerFn({ method: "GET" })
  .validator((id: string) => id)
  .handler(({ data }) => loadRegistryPlugin(registryBase(), data, getWebsiteCacheContext()));

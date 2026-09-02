import { createPaseoToolRegistry } from "../agent/tools/catalog.js";
import type { PaseoToolCatalog } from "../agent/tools/types.js";
import type { RegisterBrowserToolsOptions } from "./tools.js";
import { registerBrowserTools } from "./tools.js";

export type CreateBrowserToolsCatalogOptions = Omit<RegisterBrowserToolsOptions, "registerTool">;

export function createBrowserToolsCatalog(
  options: CreateBrowserToolsCatalogOptions,
): PaseoToolCatalog {
  const { registerTool, toCatalog } = createPaseoToolRegistry();
  registerBrowserTools({ ...options, registerTool });
  return toCatalog();
}

import type { PluginServerContext } from "@getpaseo/plugin/server";
import { registerRepositories } from "./server/register";

export default function contribute(server: PluginServerContext) {
  return registerRepositories(server);
}

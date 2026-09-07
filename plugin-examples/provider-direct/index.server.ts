import type { PluginServerContext } from "@getpaseo/plugin";
import { createDirectExampleProvider } from "./server/provider";

export default function contribute(server: PluginServerContext) {
  server.registerProvider(createDirectExampleProvider());
  return () => {};
}

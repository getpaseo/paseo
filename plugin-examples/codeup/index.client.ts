import type { PluginClientContext } from "@getpaseo/plugin";
import { codeupClientProvider } from "./client/codeup";

export default function contribute(client: PluginClientContext) {
  client.addForgeClientProvider(codeupClientProvider);
  return () => {};
}

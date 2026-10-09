import type { PluginClientContext } from "@getpaseo/plugin/client";
import { ProviderResult } from "./client/provider-result";
import { providerResultKind, providerResultSchema } from "./shared/provider-result";

export default function contribute(client: PluginClientContext) {
  client.addTimelineRenderer({
    kind: providerResultKind,
    version: 1,
    schema: providerResultSchema,
    Component: ProviderResult,
  });
  return () => {};
}

import type { PluginServerContext } from "@getpaseo/plugin/server";
import { runAcpProvider } from "@getpaseo/plugin/server/acp";

export default function contribute(server: Pick<PluginServerContext, "registerProvider">) {
  server.registerProvider({
    requiresConfiguration: true,
    ...runAcpProvider({
      id: "roder",
      label: "Roder",
      description: "Roder's local coding agent through its ACP stdio endpoint",
      command: ["roder", "acp"],
      acpOptions: { protocol: "v1", workspaceOnlyCatalog: true },
    }),
  });
  return () => {};
}

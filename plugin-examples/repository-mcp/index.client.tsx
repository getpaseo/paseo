import type { PluginClientContext } from "@getpaseo/plugin/client";
import { Repositories } from "./client/repositories";

export default function contribute(client: PluginClientContext) {
  client.addSettingsScreen({
    id: "repositories",
    title: "Fictional repositories",
    icon: "Database",
    Component: Repositories,
  });
  return () => {};
}

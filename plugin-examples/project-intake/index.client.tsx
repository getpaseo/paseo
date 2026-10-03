import type { PluginClientContext } from "@getpaseo/plugin/client";
import { ProjectIntakeSettings } from "./client/settings";
import { registerProjectCheck } from "./client/check";

export default function contribute(client: PluginClientContext) {
  if (typeof client.addSubmissionCheck !== "function") {
    throw new Error(
      "Update PandaOS to a version with submission checks before enabling Project intake.",
    );
  }
  client.addSettingsScreen({
    id: "intake",
    title: "Project intake",
    icon: "FolderCheck",
    Component: ProjectIntakeSettings,
  });
  const remove = registerProjectCheck(client);
  return () => {
    remove();
  };
}

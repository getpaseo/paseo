import type { PluginClientContext } from "@getpaseo/plugin/client";
import { spacedriveStatus } from "./shared/spacedrive.js";

export default function contribute(client: PluginClientContext) {
  client.addCommandCenterItem({
    id: "spacedrive-status",
    title: "Check Spacedrive daemon",
    icon: "HardDrive",
    context: "global",
    async onSelect({ rpc }) {
      const result = await rpc(spacedriveStatus, {});
      if (!result.running) throw new Error("Spacedrive daemon is not running");
    },
  });
  return () => {};
}

import { useEffect } from "react";
import type { AgentSkillSelection } from "@getpaseo/protocol/messages";
import { getDesktopDaemonStatus, shouldUseDesktopDaemon } from "@/desktop/daemon/desktop-daemon";
import {
  deleteLegacySkillSelection,
  readLegacySkillSelection,
} from "@/desktop/daemon/desktop-daemon";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";

interface LegacySelectionClient {
  importLegacyAgentSkillsSelection(selection: AgentSkillSelection): Promise<unknown>;
}

export async function migrateLegacyAgentSkillsSelection(
  client: LegacySelectionClient,
  read = readLegacySkillSelection,
  remove = deleteLegacySkillSelection,
): Promise<boolean> {
  const selection = await read();
  if (!selection) return false;
  await client.importLegacyAgentSkillsSelection(selection);
  await remove();
  return true;
}

// COMPAT(desktopSkillSelectionMigration): added in v0.4.0; remove after 2027-02-16.
export function LegacyAgentSkillsMigration() {
  const connectedManagedHosts = useSessionStore((state) =>
    Object.entries(state.sessions)
      .filter(([, session]) => session.serverInfo?.desktopManaged === true)
      .map(([serverId]) => serverId)
      .sort()
      .join(","),
  );
  useEffect(() => {
    if (!shouldUseDesktopDaemon() || !connectedManagedHosts) return;
    async function migrate(): Promise<void> {
      const status = await getDesktopDaemonStatus();
      if (status.status !== "running" || !status.desktopManaged) return;
      const client = getHostRuntimeStore().getSnapshot(status.serverId)?.client;
      if (!client) return;
      await migrateLegacyAgentSkillsSelection(client);
    }
    void migrate().catch((error) => {
      console.error("[Agent skills] Legacy selection migration failed; will retry", error);
    });
  }, [connectedManagedHosts]);
  return null;
}

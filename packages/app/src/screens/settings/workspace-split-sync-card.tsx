import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { WorkspaceSplitSyncMode } from "@getpaseo/protocol/workspace-tab-layout";
import { SettingsCard, SettingsSelect } from "@/components/settings";
import { useToast } from "@/contexts/toast-context";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
import { useHostFeature } from "@/runtime/host-features";
import { useHostRuntimeIsConnected } from "@/runtime/host-runtime";

const MODES: WorkspaceSplitSyncMode[] = ["off", "desktop", "all"];

export function WorkspaceSplitSyncCard({ serverId }: { serverId: string }) {
  const { t } = useTranslation();
  const supported = useHostFeature(serverId, "workspaceTabSync");
  const { config, patchConfig } = useDaemonConfig(supported ? serverId : null);
  const connected = useHostRuntimeIsConnected(serverId);
  const toast = useToast();

  const options = useMemo(
    () =>
      MODES.map((value) => ({
        value,
        label: t(`settings.workspaceSplitSync.${value}`),
      })),
    [t],
  );
  const change = useCallback(
    (workspaceSplitSync: WorkspaceSplitSyncMode) => {
      void patchConfig({ workspaceSplitSync }).catch((error) =>
        toast.error(error instanceof Error ? error.message : String(error)),
      );
    },
    [patchConfig, toast],
  );
  if (!supported) return null;

  return (
    <SettingsCard>
      <SettingsSelect
        label={t("settings.workspaceSplitSync.label")}
        value={config?.workspaceSplitSync ?? "off"}
        options={options}
        disabled={!connected || !config}
        onValueChange={change}
      />
    </SettingsCard>
  );
}

import { useCallback } from "react";
import { PaseoAgentSettingsSheet } from "@/components/paseo-agent-settings-sheet";
import { ProviderDiagnosticSheet } from "@/components/provider-diagnostic-sheet";
import { useProviderSettingsStore } from "@/stores/provider-settings-store";

const PASEO_AGENT_PROVIDER = "paseo";

export function ProviderSettingsHost() {
  const serverId = useProviderSettingsStore((state) => state.serverId);
  const provider = useProviderSettingsStore((state) => state.provider);
  const visible = useProviderSettingsStore((state) => state.visible);
  const close = useProviderSettingsStore((state) => state.close);

  const handleClose = useCallback(() => {
    close();
  }, [close]);

  if (!serverId || !provider) {
    return null;
  }

  if (provider === PASEO_AGENT_PROVIDER) {
    return <PaseoAgentSettingsSheet serverId={serverId} visible={visible} onClose={handleClose} />;
  }

  return (
    <ProviderDiagnosticSheet
      key={`${serverId}:${provider}`}
      provider={provider}
      serverId={serverId}
      visible={visible}
      onClose={handleClose}
    />
  );
}

import { useCallback } from "react";
import { ProviderDetailSheet } from "@/provider-settings";
import { OverlayLayerProvider } from "@/lib/overlay-root";
import { useProviderSettingsStore } from "@/stores/provider-settings-store";

export function ProviderSettingsHost() {
  const serverId = useProviderSettingsStore((state) => state.serverId);
  const provider = useProviderSettingsStore((state) => state.provider);
  const visible = useProviderSettingsStore((state) => state.visible);
  const overlayParentLayer = useProviderSettingsStore((state) => state.overlayParentLayer);
  const close = useProviderSettingsStore((state) => state.close);

  const handleClose = useCallback(() => {
    close();
  }, [close]);

  if (!serverId || !provider) {
    return null;
  }

  return (
    <OverlayLayerProvider layer={overlayParentLayer}>
      <ProviderDetailSheet
        key={`${serverId}:${provider}`}
        provider={provider}
        serverId={serverId}
        visible={visible}
        onClose={handleClose}
      />
    </OverlayLayerProvider>
  );
}

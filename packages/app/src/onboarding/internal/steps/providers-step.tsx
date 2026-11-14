import { useCallback } from "react";
import { View } from "react-native";
import { ProvidersSection } from "@/screens/settings/providers-section";
import { useProviderSettingsStore } from "@/stores/provider-settings-store";

export function ProvidersStep({ serverId }: { serverId: string }) {
  const openProviderSheet = useProviderSettingsStore((state) => state.open);
  const openProvider = useCallback(
    (providerId: string) => openProviderSheet({ serverId, provider: providerId }),
    [openProviderSheet, serverId],
  );
  return (
    <View>
      <ProvidersSection serverId={serverId} onOpenProvider={openProvider} />
    </View>
  );
}

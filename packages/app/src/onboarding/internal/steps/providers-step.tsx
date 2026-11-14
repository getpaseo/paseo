import { useCallback } from "react";
import { View } from "react-native";
import { ProviderList } from "@/provider-settings";
import { useProviderSettingsStore } from "@/stores/provider-settings-store";

export function ProvidersStep({ serverId }: { serverId: string }) {
  const openProviderSheet = useProviderSettingsStore((state) => state.open);
  const openProvider = useCallback(
    (providerId: string) => openProviderSheet({ serverId, provider: providerId }),
    [openProviderSheet, serverId],
  );
  return (
    <View>
      <ProviderList serverId={serverId} onOpenProvider={openProvider} />
    </View>
  );
}

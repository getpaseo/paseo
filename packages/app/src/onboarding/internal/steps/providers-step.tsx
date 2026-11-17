import { View } from "react-native";
import { ProvidersSection } from "@/screens/settings/providers-section";

export function ProvidersStep({ serverId }: { serverId: string }) {
  return (
    <View>
      <ProvidersSection serverId={serverId} />
    </View>
  );
}

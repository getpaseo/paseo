import type { ReactElement } from "react";
import { SquareTerminal } from "lucide-react-native";
import { withUnistyles } from "react-native-unistyles";
import { getProviderIcon } from "@/components/provider-icons";
import type { Theme } from "@/styles/theme";

const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

const ThemedSquareTerminal = withUnistyles(SquareTerminal);

function ProviderProfileIcon({
  iconKey,
  size,
  color = "",
}: {
  iconKey: string;
  size: number;
  color?: string;
}) {
  const Icon = getProviderIcon(iconKey);
  return <Icon size={size} color={color} />;
}

const ThemedProviderProfileIcon = withUnistyles(ProviderProfileIcon);

export function TerminalProfileIcon({
  iconKey,
  size = 14,
}: {
  iconKey: string | undefined;
  size?: number;
}): ReactElement {
  if (!iconKey) {
    return <ThemedSquareTerminal size={size} uniProps={mutedColorMapping} />;
  }
  return <ThemedProviderProfileIcon iconKey={iconKey} size={size} uniProps={mutedColorMapping} />;
}

import { SystemBars } from "react-native-edge-to-edge";
import { withUnistyles } from "react-native-unistyles";
import type { Theme } from "@/styles/theme";

function ThemeSystemBars({ colorScheme }: Pick<Theme, "colorScheme">) {
  return <SystemBars style={colorScheme === "light" ? "dark" : "light"} />;
}

export const AppearanceSystemBars = withUnistyles(ThemeSystemBars, (theme) => ({
  colorScheme: theme.colorScheme,
}));

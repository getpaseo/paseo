import { SystemBars } from "react-native-edge-to-edge";
import { withUnistyles } from "react-native-unistyles";

export const AppearanceSystemBars = withUnistyles(SystemBars, (theme) => ({
  style: theme.colorScheme === "light" ? "dark" : "light",
}));

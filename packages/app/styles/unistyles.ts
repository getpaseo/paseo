import { StyleSheet } from "react-native-unistyles";
import { theme } from "./theme";

// Configure Unistyles with our theme
StyleSheet.configure({
  themes: {
    dark: theme,
  },
  settings: {
    initialTheme: "dark",
  },
});

// Type augmentation for TypeScript
type AppThemes = {
  dark: typeof theme;
};

declare module "react-native-unistyles" {
  export interface UnistylesThemes extends AppThemes {}
}

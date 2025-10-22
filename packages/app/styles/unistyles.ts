import { StyleSheet } from "react-native-unistyles";
import { lightTheme, darkTheme } from "./theme";

// Configure Unistyles with adaptive themes
StyleSheet.configure({
  themes: {
    light: lightTheme,
    dark: darkTheme,
  },
  settings: {
    adaptiveThemes: true,
  },
});

// Type augmentation for TypeScript
type AppThemes = {
  light: typeof lightTheme;
  dark: typeof darkTheme;
};

declare module "react-native-unistyles" {
  export interface UnistylesThemes extends AppThemes {}
}

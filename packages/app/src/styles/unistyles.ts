import { StyleSheet } from "react-native-unistyles";
import { REGISTERED_THEMES } from "./theme";
import { APP_BREAKPOINTS } from "./breakpoints";

StyleSheet.configure({
  themes: REGISTERED_THEMES,
  breakpoints: APP_BREAKPOINTS,
  settings: {
    adaptiveThemes: true,
  },
});

// Type augmentation for TypeScript
type AppThemes = typeof REGISTERED_THEMES;

type AppBreakpoints = typeof APP_BREAKPOINTS;

declare module "react-native-unistyles" {
  export interface UnistylesThemes extends AppThemes {}
  export interface UnistylesBreakpoints extends AppBreakpoints {}
}

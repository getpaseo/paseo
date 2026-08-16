import { StyleSheet } from "react-native-unistyles";
import { REGISTERED_THEMES } from "./theme";

export const APP_BREAKPOINTS = {
  xs: 0,
  sm: 576,
  md: 720,
  lg: 992,
  xl: 1200,
} as const;

StyleSheet.configure({
  themes: REGISTERED_THEMES,
  breakpoints: APP_BREAKPOINTS,
  settings: {
    adaptiveThemes: true,
  },
});

// Type augmentation for TypeScript
type AppThemes = typeof REGISTERED_THEMES;

interface AppBreakpoints {
  xs: number;
  sm: number;
  md: number;
  lg: number;
  xl: number;
}

declare module "react-native-unistyles" {
  export interface UnistylesThemes extends AppThemes {}
  export interface UnistylesBreakpoints extends AppBreakpoints {}
}

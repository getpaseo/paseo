import { StyleSheet } from "react-native-unistyles";
// import { UnistylesRuntime } from "react-native-unistyles";
import { lightTheme, darkTheme } from "./theme";

console.log("[Unistyles] Configuring...");

// // Configure Unistyles with adaptive themes
StyleSheet.configure({
  themes: {
    light: lightTheme,
    dark: darkTheme,
  },
  breakpoints: {
    xs: 0,
    sm: 576,
    md: 768,
    lg: 992,
    xl: 1200,
  },
  settings: {
    adaptiveThemes: true,
  },
});

console.log("[Unistyles] Configuration complete!");

// Type augmentation for TypeScript
type AppThemes = {
  light: typeof lightTheme;
  dark: typeof darkTheme;
};

type AppBreakpoints = {
  xs: number;
  sm: number;
  md: number;
  lg: number;
  xl: number;
};

declare module "react-native-unistyles" {
  export interface UnistylesThemes extends AppThemes {}
  export interface UnistylesBreakpoints extends AppBreakpoints {}
}

console.log(lightTheme.colors.background);

// UnistylesRuntime.setRootViewBackgroundColor(lightTheme.colors.background);

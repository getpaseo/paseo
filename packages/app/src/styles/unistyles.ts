import { StyleSheet } from "react-native-unistyles";
// import { UnistylesRuntime } from "react-native-unistyles";
import { lightTheme, darkTheme, colorblindTheme } from "./theme";

StyleSheet.configure({
  themes: {
    light: lightTheme,
    dark: darkTheme,
    colorblind: colorblindTheme,
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

// Type augmentation for TypeScript
type AppThemes = {
  light: typeof lightTheme;
  dark: typeof darkTheme;
  colorblind: typeof colorblindTheme;
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

// UnistylesRuntime.setRootViewBackgroundColor(lightTheme.colors.background);

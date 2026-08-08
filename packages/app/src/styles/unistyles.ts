import { StyleSheet } from "react-native-unistyles";
import {
  lightTheme,
  darkTheme,
  darkZincTheme,
  darkMidnightTheme,
  darkClaudeTheme,
  darkGhosttyTheme,
  darkAmoledTheme,
  lightCatppuccinLatteTheme,
  darkCatppuccinFrappeTheme,
  darkCatppuccinMacchiatoTheme,
  darkCatppuccinMochaTheme,
} from "./theme";

StyleSheet.configure({
  themes: {
    light: lightTheme,
    dark: darkTheme,
    darkZinc: darkZincTheme,
    darkMidnight: darkMidnightTheme,
    darkClaude: darkClaudeTheme,
    darkGhostty: darkGhosttyTheme,
    darkAmoled: darkAmoledTheme,
    catppuccinLatte: lightCatppuccinLatteTheme,
    catppuccinFrappe: darkCatppuccinFrappeTheme,
    catppuccinMacchiato: darkCatppuccinMacchiatoTheme,
    catppuccinMocha: darkCatppuccinMochaTheme,
  },
  breakpoints: {
    xs: 0,
    sm: 576,
    md: 720,
    lg: 992,
    xl: 1200,
  },
  settings: {
    adaptiveThemes: true,
  },
});

// Type augmentation for TypeScript
interface AppThemes {
  light: typeof lightTheme;
  dark: typeof darkTheme;
  darkZinc: typeof darkZincTheme;
  darkMidnight: typeof darkMidnightTheme;
  darkClaude: typeof darkClaudeTheme;
  darkGhostty: typeof darkGhosttyTheme;
  darkAmoled: typeof darkAmoledTheme;
  catppuccinLatte: typeof lightCatppuccinLatteTheme;
  catppuccinFrappe: typeof darkCatppuccinFrappeTheme;
  catppuccinMacchiato: typeof darkCatppuccinMacchiatoTheme;
  catppuccinMocha: typeof darkCatppuccinMochaTheme;
}

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

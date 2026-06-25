import type { Theme } from "@/styles/theme";

export interface MermaidThemeVariables {
  darkMode: boolean;
  background: string;
  mainBkg: string;
  secondBkg: string;
  tertiaryBkg: string;
  primaryColor: string;
  primaryTextColor: string;
  primaryBorderColor: string;
  secondaryColor: string;
  secondaryTextColor: string;
  secondaryBorderColor: string;
  tertiaryColor: string;
  tertiaryTextColor: string;
  tertiaryBorderColor: string;
  lineColor: string;
  textColor: string;
  border1: string;
  border2: string;
  noteBkgColor: string;
  noteTextColor: string;
  noteBorderColor: string;
  errorBkgColor: string;
  errorTextColor: string;
}

export function buildMermaidThemeVariables(theme: Theme): MermaidThemeVariables {
  const { colors } = theme;
  const isDark = theme.colorScheme === "dark";

  return {
    darkMode: isDark,
    background: colors.surface0,
    mainBkg: colors.surface2,
    secondBkg: colors.surface1,
    tertiaryBkg: colors.surface3,
    primaryColor: colors.surface2,
    primaryTextColor: colors.foreground,
    primaryBorderColor: colors.border,
    secondaryColor: colors.surface3,
    secondaryTextColor: colors.foreground,
    secondaryBorderColor: colors.border,
    tertiaryColor: colors.surface1,
    tertiaryTextColor: colors.foregroundMuted,
    tertiaryBorderColor: colors.border,
    lineColor: colors.border,
    textColor: colors.foreground,
    border1: colors.border,
    border2: colors.borderAccent,
    noteBkgColor: colors.surface2,
    noteTextColor: colors.foreground,
    noteBorderColor: colors.border,
    errorBkgColor: colors.surface2,
    errorTextColor: colors.destructive,
  };
}

export function buildMermaidThemeKey(variables: MermaidThemeVariables): string {
  return JSON.stringify(variables);
}

import type { Theme } from "@/styles/theme";

/** Mermaid `theme: "base"` variables — tuned for diagram edge/node contrast, not 1:1 app surfaces. */
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
  nodeBkg: string;
  nodeBorder: string;
  clusterBkg: string;
  clusterBorder: string;
  defaultLinkColor: string;
  arrowheadColor: string;
  edgeLabelBackground: string;
  labelBackground: string;
  labelBackgroundColor: string;
  classText: string;
  actorBkg: string;
  actorBorder: string;
  actorTextColor: string;
  actorLineColor: string;
  signalColor: string;
  signalTextColor: string;
  labelBoxBkgColor: string;
  labelBoxBorderColor: string;
  labelTextColor: string;
  activationBkgColor: string;
  activationBorderColor: string;
  sequenceNumberColor: string;
  stateBkg: string;
  stateLabelColor: string;
  transitionColor: string;
  transitionLabelColor: string;
  relationColor: string;
  relationLabelBackground: string;
  relationLabelColor: string;
  quadrantInternalBorderStrokeFill: string;
  quadrantExternalBorderStrokeFill: string;
  quadrantPointFill: string;
  quadrantPointTextFill: string;
  pieSectionTextColor: string;
  pieLegendTextColor: string;
  pieStrokeColor: string;
  commitLabelColor: string;
  commitLabelBackground: string;
  branchLabelColor: string;
  tagLabelColor: string;
  tagLabelBackground: string;
  tagLabelBorder: string;
}

interface MermaidReadabilityPalette {
  background: string;
  nodeFill: string;
  nodeBorder: string;
  text: string;
  mutedText: string;
  line: string;
  labelFill: string;
  clusterFill: string;
  clusterBorder: string;
  noteFill: string;
  errorText: string;
}

const lightMermaidPalette: MermaidReadabilityPalette = {
  background: "#f7f7f8",
  nodeFill: "#ffffff",
  nodeBorder: "#c9cdd3",
  text: "#111827",
  mutedText: "#374151",
  line: "#6b7280",
  labelFill: "#ffffff",
  clusterFill: "#f1f3f5",
  clusterBorder: "#cbd5e1",
  noteFill: "#f1f3f5",
  errorText: "#b91c1c",
};

const darkMermaidPalette: MermaidReadabilityPalette = {
  background: "#202423",
  nodeFill: "#2c312f",
  nodeBorder: "#66736d",
  text: "#f3f4f6",
  mutedText: "#d1d5db",
  line: "#aeb8b3",
  labelFill: "#303633",
  clusterFill: "#262b29",
  clusterBorder: "#5f6b66",
  noteFill: "#2c312f",
  errorText: "#f87171",
};

function paletteForTheme(theme: Theme): MermaidReadabilityPalette {
  return theme.colorScheme === "dark" ? darkMermaidPalette : lightMermaidPalette;
}

function mapPaletteToVariables(
  palette: MermaidReadabilityPalette,
  isDark: boolean,
): MermaidThemeVariables {
  return {
    darkMode: isDark,
    background: palette.background,
    mainBkg: palette.nodeFill,
    secondBkg: palette.clusterFill,
    tertiaryBkg: palette.labelFill,
    primaryColor: palette.nodeFill,
    primaryTextColor: palette.text,
    primaryBorderColor: palette.nodeBorder,
    secondaryColor: palette.clusterFill,
    secondaryTextColor: palette.text,
    secondaryBorderColor: palette.clusterBorder,
    tertiaryColor: palette.labelFill,
    tertiaryTextColor: palette.mutedText,
    tertiaryBorderColor: palette.nodeBorder,
    lineColor: palette.line,
    textColor: palette.text,
    border1: palette.nodeBorder,
    border2: palette.clusterBorder,
    noteBkgColor: palette.noteFill,
    noteTextColor: palette.text,
    noteBorderColor: palette.nodeBorder,
    errorBkgColor: palette.nodeFill,
    errorTextColor: palette.errorText,
    nodeBkg: palette.nodeFill,
    nodeBorder: palette.nodeBorder,
    clusterBkg: palette.clusterFill,
    clusterBorder: palette.clusterBorder,
    defaultLinkColor: palette.line,
    arrowheadColor: palette.line,
    edgeLabelBackground: palette.labelFill,
    labelBackground: palette.labelFill,
    labelBackgroundColor: palette.labelFill,
    classText: palette.text,
    actorBkg: palette.nodeFill,
    actorBorder: palette.nodeBorder,
    actorTextColor: palette.text,
    actorLineColor: palette.line,
    signalColor: palette.line,
    signalTextColor: palette.text,
    labelBoxBkgColor: palette.labelFill,
    labelBoxBorderColor: palette.nodeBorder,
    labelTextColor: palette.text,
    activationBkgColor: palette.clusterFill,
    activationBorderColor: palette.nodeBorder,
    sequenceNumberColor: palette.mutedText,
    stateBkg: palette.nodeFill,
    stateLabelColor: palette.text,
    transitionColor: palette.line,
    transitionLabelColor: palette.mutedText,
    relationColor: palette.line,
    relationLabelBackground: palette.labelFill,
    relationLabelColor: palette.text,
    quadrantInternalBorderStrokeFill: palette.clusterBorder,
    quadrantExternalBorderStrokeFill: palette.line,
    quadrantPointFill: palette.line,
    quadrantPointTextFill: palette.text,
    pieSectionTextColor: palette.text,
    pieLegendTextColor: palette.mutedText,
    pieStrokeColor: palette.line,
    commitLabelColor: palette.text,
    commitLabelBackground: palette.labelFill,
    branchLabelColor: palette.mutedText,
    tagLabelColor: palette.text,
    tagLabelBackground: palette.labelFill,
    tagLabelBorder: palette.nodeBorder,
  };
}

export function buildMermaidThemeVariables(theme: Theme): MermaidThemeVariables {
  const isDark = theme.colorScheme === "dark";
  const palette = paletteForTheme(theme);
  return mapPaletteToVariables(palette, isDark);
}

export function buildMermaidThemeKey(variables: MermaidThemeVariables): string {
  return JSON.stringify(variables);
}

import type { WorkspaceLabelColor } from "@getpaseo/protocol/workspace-labels";
import type { Theme } from "@/styles/theme";
import { i18n } from "@/i18n/i18next";

export const WORKSPACE_LABEL_COLOR_STYLE: Record<
  WorkspaceLabelColor,
  `labelColor${Capitalize<WorkspaceLabelColor>}`
> = {
  violet: "labelColorViolet",
  sky: "labelColorSky",
  emerald: "labelColorEmerald",
  orange: "labelColorOrange",
  pink: "labelColorPink",
  indigo: "labelColorIndigo",
  teal: "labelColorTeal",
  red: "labelColorRed",
  amber: "labelColorAmber",
  blue: "labelColorBlue",
};

export function workspaceLabelColorName(color: WorkspaceLabelColor): string {
  return i18n.t(`workspaceLabels.colors.${color}`);
}

export function workspaceLabelColorMapping(color: WorkspaceLabelColor) {
  return (theme: Theme): { color: string } => ({
    color: theme.colors.palette.workspaceLabel[color],
  });
}

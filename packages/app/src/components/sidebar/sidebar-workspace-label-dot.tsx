import { useMemo, type ReactElement } from "react";
import { View, type ViewStyle } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";

const LABEL_COLOR_COUNT = 6;

export function workspaceLabelColorIndex(labelKey: string): number {
  let hash = 0;
  for (let index = 0; index < labelKey.length; index += 1) {
    hash = (hash * 31 + labelKey.charCodeAt(index)) >>> 0;
  }
  return hash % LABEL_COLOR_COUNT;
}

export function SidebarWorkspaceLabelDot({
  labelKey,
  label,
}: {
  labelKey: string;
  label: string;
}): ReactElement {
  const { t } = useTranslation();
  const colorStyle = useMemo<ViewStyle>(() => {
    switch (workspaceLabelColorIndex(labelKey)) {
      case 0:
        return styles.blue;
      case 1:
        return styles.purple;
      case 2:
        return styles.amber;
      case 3:
        return styles.green;
      case 4:
        return styles.red;
      default:
        return styles.cyan;
    }
  }, [labelKey]);
  const dotStyle = useMemo(() => [styles.dot, colorStyle], [colorStyle]);

  return (
    <View
      accessible
      accessibilityLabel={t("sidebar.organization.workspaceLabel.accessibility", { label })}
      style={dotStyle}
      testID={`workspace-label-dot-${labelKey}`}
    />
  );
}

const styles = StyleSheet.create((theme) => ({
  dot: {
    width: 7,
    height: 7,
    borderRadius: theme.borderRadius.full,
    flexShrink: 0,
  },
  blue: { backgroundColor: theme.colors.palette.blue[400] },
  purple: { backgroundColor: theme.colors.palette.purple[500] },
  amber: { backgroundColor: theme.colors.palette.amber[500] },
  green: { backgroundColor: theme.colors.palette.green[400] },
  red: { backgroundColor: theme.colors.palette.red[500] },
  cyan: { backgroundColor: theme.colors.palette.orange[500] },
}));

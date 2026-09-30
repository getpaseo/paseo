import { useMemo, type ReactNode } from "react";
import { Text, type StyleProp, type TextStyle } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { DISPLAY_FONT_DATASET } from "@/styles/font-dataset";

interface ScreenTitleProps {
  children: ReactNode;
  numberOfLines?: number;
  testID?: string;
  style?: StyleProp<TextStyle>;
  /** Large Claude-style serif hub title (e.g. Code, Chats). Default stays quiet. */
  hub?: boolean;
}

/**
 * Canonical screen title for use inside `ScreenHeader`. One typography, one
 * color, responsive weight. Leading icons are siblings (HeaderToggleButton,
 * HeaderIconBadge) — never nested inside this component.
 * `hub` opts into the large display-serif variant for hub screens.
 */
export function ScreenTitle({
  children,
  numberOfLines = 1,
  testID,
  style,
  hub = false,
}: ScreenTitleProps) {
  const combinedStyle = useMemo(() => [styles.text, hub && styles.hubText, style], [hub, style]);
  return (
    <Text
      dataSet={hub ? DISPLAY_FONT_DATASET : undefined}
      style={combinedStyle}
      numberOfLines={numberOfLines}
      testID={testID}
    >
      {children}
    </Text>
  );
}

const styles = StyleSheet.create((theme) => ({
  text: {
    flexShrink: 1,
    minWidth: 0,
    fontSize: theme.fontSize.base,
    fontWeight: {
      xs: "400",
      md: "300",
    },
    color: theme.colors.foreground,
  },
  hubText: {
    fontFamily: theme.fontFamily.display,
    fontSize: theme.fontSize["4xl"],
    fontWeight: "400",
  },
}));

import type { ReactNode } from "react";
import { Fragment } from "react";
import { View, type StyleProp, type ViewStyle } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { TitlebarDragRegion } from "@/components/desktop/titlebar-drag-region";

interface SidebarShellHeaderProps {
  children: ReactNode;
  topSpacerStyle?: StyleProp<ViewStyle>;
  toggleSlot?: ReactNode;
  withTitlebarDragRegion?: boolean;
}

export function SidebarShellHeader({
  children,
  topSpacerStyle,
  toggleSlot,
  withTitlebarDragRegion = false,
}: SidebarShellHeaderProps) {
  const content = (
    <Fragment>
      {withTitlebarDragRegion ? <TitlebarDragRegion /> : null}
      {topSpacerStyle ? <View style={topSpacerStyle} /> : null}
      {children}
      {toggleSlot}
    </Fragment>
  );

  if (withTitlebarDragRegion || topSpacerStyle) {
    return <View style={styles.headerDragArea}>{content}</View>;
  }

  return content;
}

const styles = StyleSheet.create(() => ({
  headerDragArea: {
    position: "relative",
  },
}));

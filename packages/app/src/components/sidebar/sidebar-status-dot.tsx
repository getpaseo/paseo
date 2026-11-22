import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { ProjectStatusBadgeDotBucket } from "@/utils/project-status-badge-content";
import { getStatusDotColor } from "@/utils/status-dot-color";
import { STATUS_INDICATOR_FILLED_DOT_SIZE } from "@/utils/status-indicator-geometry";

export function SidebarStatusDot({
  bucket,
  testID,
}: {
  bucket: ProjectStatusBadgeDotBucket;
  testID?: string;
}) {
  return <View testID={testID} style={styles.dot(bucket)} />;
}

const styles = StyleSheet.create((theme) => ({
  dot: (bucket: ProjectStatusBadgeDotBucket) => ({
    width: STATUS_INDICATOR_FILLED_DOT_SIZE,
    height: STATUS_INDICATOR_FILLED_DOT_SIZE,
    borderRadius: theme.borderRadius.full,
    backgroundColor: getStatusDotColor({ theme, bucket }) ?? undefined,
  }),
}));

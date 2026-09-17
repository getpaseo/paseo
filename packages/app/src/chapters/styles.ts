import { StyleSheet } from "react-native-unistyles";
export const chapterStyles = StyleSheet.create((theme) => ({
  container: { flex: 1, minHeight: 0 },
  fill: { flex: 1 },
  status: { flexShrink: 0 },
  row: {
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[3],
    gap: theme.spacing[1],
  },
  category: { flexDirection: "row", alignItems: "center", gap: theme.spacing[2] },
  introduction: { padding: theme.spacing[4], gap: theme.spacing[2] },
  heading: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.lg,
    fontWeight: theme.fontWeight.medium,
  },
  title: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.normal,
  },
  description: { color: theme.colors.foreground, fontSize: theme.fontSize.base },
  muted: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  message: { color: theme.colors.foregroundMuted, padding: theme.spacing[3] },
  error: { color: theme.colors.destructive, padding: theme.spacing[3] },
}));

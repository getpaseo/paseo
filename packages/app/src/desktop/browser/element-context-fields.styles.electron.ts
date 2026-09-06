import type { CSSProperties } from "react";
import { StyleSheet } from "react-native-unistyles";

export const nativeColorInputStyle: CSSProperties = {
  width: 32,
  height: 28,
  marginLeft: 6,
  padding: 0,
  border: 0,
  background: "transparent",
  cursor: "pointer",
};

export const nativeRangeInputStyle: CSSProperties = {
  flex: 1,
  minWidth: 0,
  margin: "0 8px",
  cursor: "pointer",
};

export const nativeDateInputStyle: CSSProperties = {
  flex: 1,
  minWidth: 0,
  height: 30,
  padding: "0 8px",
  border: 0,
  outline: "none",
  color: "inherit",
  background: "transparent",
  font: "inherit",
  colorScheme: "light dark",
};

export const elementContextFieldStyles = StyleSheet.create((theme) => ({
  scroller: { flexShrink: 1, minHeight: 0 },
  fields: { paddingBottom: theme.spacing[1] },
  group: {
    paddingVertical: theme.spacing[2],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  groupLabel: {
    paddingHorizontal: theme.spacing[3],
    paddingBottom: theme.spacing[1],
    fontSize: theme.fontSize.sm,
    fontWeight: "600",
    color: theme.colors.foregroundMuted,
  },
  fieldRow: {
    minHeight: 38,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
  },
  stackedField: {
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[1],
  },
  labelWrap: { width: 104, flexShrink: 0 },
  stackedLabelWrap: { width: "100%" },
  label: { fontSize: theme.fontSize.sm, color: theme.colors.foreground },
  description: { fontSize: theme.fontSize.sm, color: theme.colors.foregroundMuted },
  fieldControl: { flex: 1, minWidth: 0 },
  booleanControl: { flex: 1, minWidth: 0, alignItems: "flex-end" },
  inputWrap: {
    flex: 1,
    minWidth: 0,
    minHeight: 32,
    flexDirection: "row",
    alignItems: "center",
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
  },
  invalidInputWrap: { borderColor: theme.colors.destructive },
  fontPresetsTrigger: {
    width: 32,
    height: 32,
    alignItems: "center",
    justifyContent: "center",
  },
  stackedControl: { width: "100%", flex: 0 },
  input: {
    flex: 1,
    minWidth: 0,
    minHeight: 32,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
  },
  multilineInput: { minHeight: 72, textAlignVertical: "top" },
  nativeValue: {
    minWidth: 40,
    paddingRight: theme.spacing[2],
    textAlign: "right",
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  unit: {
    paddingRight: theme.spacing[2],
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  optionList: {
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    overflow: "hidden",
  },
  optionRow: {
    minHeight: 32,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[2],
  },
  optionRowHovered: { backgroundColor: theme.colors.surface2 },
  checkbox: {
    width: 16,
    height: 16,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.borderRadius.sm,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  checkboxSelected: { backgroundColor: theme.colors.accent, borderColor: theme.colors.accent },
  optionLabel: { flex: 1, fontSize: theme.fontSize.sm, color: theme.colors.foreground },
}));

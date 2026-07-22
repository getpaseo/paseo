import React, { type ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { CountedCheckPresentation } from "@/git/check-presentation";
import {
  CheckPresentationIcon,
  getCheckPresentationTone,
  type CheckPresentationTone,
} from "@/git/check-presentation.view";
import { ChevronDown, ChevronRight } from "lucide-react-native";
import type { Theme } from "@/styles/theme";

const ThemedChevronDown = withUnistyles(ChevronDown);
const ThemedChevronRight = withUnistyles(ChevronRight);

export const foregroundMutedColorMapping = (theme: Theme) => ({
  color: theme.colors.foregroundMuted,
});
export const successColorMapping = (theme: Theme) => ({ color: theme.colors.statusSuccess });
export const dangerColorMapping = (theme: Theme) => ({ color: theme.colors.statusDanger });
export const warningColorMapping = (theme: Theme) => ({ color: theme.colors.statusWarning });

interface SectionProps {
  title: string;
  open: boolean;
  onToggle: () => void;
  summary: ReactNode;
  children: ReactNode;
  accessibilityLabel?: string;
}

export function Section({
  title,
  open,
  onToggle,
  summary,
  children,
  accessibilityLabel,
}: SectionProps) {
  return (
    <View>
      <Pressable
        accessibilityLabel={accessibilityLabel}
        style={sectionKitStyles.sectionHeader}
        onPress={onToggle}
      >
        {open ? (
          <ThemedChevronDown size={14} uniProps={foregroundMutedColorMapping} />
        ) : (
          <ThemedChevronRight size={14} uniProps={foregroundMutedColorMapping} />
        )}
        <Text style={sectionKitStyles.sectionTitle}>{title}</Text>
        <View style={sectionKitStyles.summaryWrap}>{summary}</View>
      </Pressable>
      {open ? <View style={sectionKitStyles.sectionBody}>{children}</View> : null}
    </View>
  );
}

export type SummaryPillVariant = CheckPresentationTone;

export function SummaryPill({
  count,
  icon,
  variant,
  testID,
}: {
  count: number;
  icon: ReactNode;
  variant: SummaryPillVariant;
  testID?: string;
}) {
  if (count === 0) return null;
  return (
    <View style={sectionKitStyles.summaryPill} testID={testID}>
      {icon}
      <Text style={summaryPillTextStyle(variant)}>{count}</Text>
    </View>
  );
}

function summaryPillTextStyle(variant: SummaryPillVariant) {
  if (variant === "success") return sectionKitStyles.summaryPillSuccessText;
  if (variant === "danger") return sectionKitStyles.summaryPillDangerText;
  if (variant === "warning") return sectionKitStyles.summaryPillWarningText;
  return sectionKitStyles.summaryPillMutedText;
}

export function CheckPresentationSummaryPill({
  count,
  presentation,
  testID,
}: {
  count: number;
  presentation: CountedCheckPresentation;
  testID?: string;
}) {
  if (count === 0) return null;
  return (
    <View style={sectionKitStyles.summaryPill} testID={testID}>
      <CheckPresentationIcon presentation={presentation} size={12} />
      <Text style={summaryPillTextStyle(getCheckPresentationTone(presentation))}>{count}</Text>
    </View>
  );
}

export const sectionKitStyles = StyleSheet.create((theme) => ({
  sectionHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
  },
  sectionTitle: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foregroundMuted,
  },
  sectionBody: {
    paddingBottom: theme.spacing[3],
  },
  summaryWrap: {
    marginLeft: "auto",
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  summaryPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 3,
  },
  summaryPillSuccessText: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.normal,
    color: theme.colors.statusSuccess,
  },
  summaryPillDangerText: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.normal,
    color: theme.colors.statusDanger,
  },
  summaryPillWarningText: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.normal,
    color: theme.colors.statusWarning,
  },
  summaryPillMutedText: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.normal,
    color: theme.colors.foregroundMuted,
  },
  emptyText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
  },
  checkRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    // Fixed, not minHeight plus padding. A row's trailing slot holds an xs Button
    // (28pt), which stacked on the vertical padding and made rows with an
    // "Add to chat" button taller than rows without one. The row is single-line by
    // construction, so it declares a height the button fits inside instead.
    height: CONTROL_HEIGHTS.compact,
  },
  checkName: {
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.normal,
    color: theme.colors.foreground,
    flexShrink: 1,
  },
  checkWorkflow: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
    flexShrink: 1,
  },
  checkTrailing: {
    marginLeft: "auto",
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  checkDuration: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
}));

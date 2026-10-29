import { MarkdownRenderer } from "@/components/markdown/renderer";
import { isWeb } from "@/constants/platform";
import type { Theme } from "@/styles/theme";
import { ChevronRight } from "lucide-react-native";
import { useCallback, useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";

export type PlanOutcome = "pending" | "approved" | "rejected" | "canceled";

interface PlanCardProps {
  title?: string;
  description?: string;
  text: string;
  outcome?: PlanOutcome;
  footer?: ReactNode;
  disableOuterSpacing?: boolean;
  testID?: string;
}

const ThemedChevron = withUnistyles(ChevronRight);
const chevronColor = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

export function PlanCard(props: PlanCardProps) {
  // A resolution starts its own presentation state; subsequent taps stay local.
  return <PlanCardContent key={props.outcome ?? "proposed"} {...props} />;
}

function PlanCardContent({
  title,
  description,
  text,
  outcome,
  footer,
  disableOuterSpacing = false,
  testID,
}: PlanCardProps) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(outcome !== "rejected" && outcome !== "canceled");
  const labels = {
    pending: title ?? t("agentStream.permission.plan"),
    rejected: t("agentStream.permission.rejectedPlan"),
    approved: t("agentStream.permission.approvedPlan"),
    canceled: t("agentStream.permission.canceledPlan"),
  };
  const resolvedTitle = labels[outcome ?? "pending"];
  const accessibilityState = useMemo(() => ({ expanded }), [expanded]);
  const webExpandedState = useMemo(
    () => (isWeb ? ({ "aria-expanded": expanded } as const) : null),
    [expanded],
  );
  const toggleExpanded = useCallback(() => setExpanded((value) => !value), []);
  const containerStyle = useMemo(
    () => [styles.container, disableOuterSpacing && styles.containerCompact],
    [disableOuterSpacing],
  );
  const chevronStyle = useMemo(
    () => [styles.chevron, expanded && styles.chevronExpanded],
    [expanded],
  );

  return (
    <View testID={testID} style={containerStyle}>
      <Pressable
        {...webExpandedState}
        accessibilityRole="button"
        accessibilityLabel={resolvedTitle}
        accessibilityState={accessibilityState}
        onPress={toggleExpanded}
        style={styles.header}
      >
        <View style={chevronStyle}>
          <ThemedChevron size={16} uniProps={chevronColor} />
        </View>
        <Text style={styles.title}>{resolvedTitle}</Text>
      </Pressable>
      {expanded ? (
        <View style={styles.body}>
          {description ? <Text style={styles.description}>{description}</Text> : null}
          <MarkdownRenderer text={text} />
        </View>
      ) : null}
      {footer ? <View style={styles.footer}>{footer}</View> : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    marginVertical: theme.spacing[3],
    padding: theme.spacing[3],
    borderRadius: theme.spacing[2],
    borderWidth: 1,
    backgroundColor: theme.colors.surface1,
    borderColor: theme.colors.border,
    gap: theme.spacing[2],
  },
  containerCompact: {
    marginVertical: 0,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    minHeight: 24,
  },
  chevron: {},
  chevronExpanded: { transform: [{ rotate: "90deg" }] },
  body: { gap: theme.spacing[2] },
  title: {
    color: theme.colors.foreground,
    flexShrink: 1,
    fontSize: theme.fontSize.base,
    lineHeight: 22,
  },
  description: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
    lineHeight: 20,
  },
  footer: {
    gap: theme.spacing[2],
  },
}));

import type { ReactElement } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { CornerUpLeft } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import { ComposerTrackMark } from "@/composer/tracks";
import { FOOTER_HEIGHT } from "@/constants/layout";
import type { Theme } from "@/styles/theme";
import { useParentAgent, type ParentAgent } from "./use-parent-agent";

function ParentIcon({
  icon: Icon,
  size,
  color = "",
}: {
  icon: ParentAgent["icon"];
  size: number;
  color?: string;
}) {
  return <Icon size={size} color={color} />;
}

const ThemedParentIcon = withUnistyles(ParentIcon);
const foregroundColorMapping = (theme: Theme) => ({ color: theme.colors.foreground });

/** Stands in the composer's place on a subagent shown without one: who the parent is, and the way back. */
export function ParentAgentCallout({
  serverId,
  parentAgentId,
}: {
  serverId: string;
  parentAgentId: string;
}): ReactElement {
  const { t } = useTranslation();
  const parent = useParentAgent(serverId, parentAgentId);

  return (
    <View style={styles.rail}>
      <View style={styles.callout} testID="parent-agent-callout">
        <View style={styles.avatar}>
          <ThemedParentIcon icon={parent.icon} size={18} uniProps={foregroundColorMapping} />
        </View>
        <View style={styles.body}>
          <Text style={styles.eyebrow}>{t("subagents.parent.parent")}</Text>
          <View style={styles.titleRow}>
            <Text style={styles.title} numberOfLines={1}>
              {parent.label ?? t("subagents.parent.parentAgent")}
            </Text>
            <ComposerTrackMark bucket={parent.statusBucket} />
          </View>
        </View>
        <Button
          size="sm"
          variant="secondary"
          leftIcon={CornerUpLeft}
          onPress={parent.open}
          testID="parent-agent-callout-open"
        >
          {t("subagents.parent.openParent")}
        </Button>
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  rail: {
    minHeight: FOOTER_HEIGHT,
    alignItems: "center",
    width: "100%",
    padding: theme.spacing[4],
  },
  callout: {
    width: "100%",
    maxWidth: theme.contentMaxWidth,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
    backgroundColor: theme.colors.surface1,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.borderAccent,
    borderRadius: theme.borderRadius["2xl"],
    padding: theme.spacing[3],
    paddingRight: { xs: theme.spacing[3], md: theme.spacing[4] },
  },
  avatar: {
    width: 36,
    height: 36,
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.surface2,
    alignItems: "center",
    justifyContent: "center",
  },
  body: {
    flex: 1,
    minWidth: 0,
    gap: theme.spacing[0.5],
  },
  eyebrow: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  titleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    minWidth: 0,
  },
  title: {
    flexShrink: 1,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
  },
}));

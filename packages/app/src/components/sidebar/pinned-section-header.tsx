import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronRight } from "lucide-react-native";
import { Pressable, Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useIsCompactFormFactor } from "@/constants/layout";
import { isNative } from "@/constants/platform";
import type { Theme } from "@/styles/theme";
import { WorkspacePinGroupMenu } from "@/workspace-pin-groups/menu";

const ThemedChevronDown = withUnistyles(ChevronDown);
const ThemedChevronRight = withUnistyles(ChevronRight);
const foregroundMutedColorMapping = (theme: Theme) => ({
  color: theme.colors.foregroundMuted,
});

export function PinnedSectionHeader({
  collapsed,
  onToggle,
  pinGroupServerId,
}: {
  collapsed: boolean;
  onToggle: () => void;
  pinGroupServerId?: string | null;
}) {
  const { t } = useTranslation();
  const isCompact = useIsCompactFormFactor();
  const accessibilityState = useMemo(() => ({ expanded: !collapsed }), [collapsed]);
  const Chevron = collapsed ? ThemedChevronRight : ThemedChevronDown;

  return (
    <View style={styles.header} testID="sidebar-pinned-section-header-row">
      <Pressable
        accessibilityRole="button"
        accessibilityState={accessibilityState}
        onPress={onToggle}
        style={styles.collapseTrigger}
        testID="sidebar-pinned-section-header"
      >
        {({ hovered }) => (
          <>
            <Text style={styles.title}>{t("sidebar.pinned.title")}</Text>
            {hovered || isNative || isCompact ? (
              <Chevron size={12} uniProps={foregroundMutedColorMapping} />
            ) : null}
          </>
        )}
      </Pressable>
      {pinGroupServerId ? <WorkspacePinGroupMenu serverId={pinGroupServerId} /> : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  header: {
    minHeight: 36,
    width: "100%",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    userSelect: "none",
  },
  collapseTrigger: {
    minHeight: 36,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    userSelect: "none",
  },
  title: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.normal,
  },
}));

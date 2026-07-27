import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Pressable,
  Text,
  type GestureResponderEvent,
  type PressableStateCallbackType,
} from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { ExternalLink, GitPullRequest } from "lucide-react-native";
import { getForgePresentation, normalizeForge } from "@/git/forge";
import type { PrHint } from "@/git/use-pr-status-query";
import type { Theme } from "@/styles/theme";
import { openExternalUrl } from "@/utils/open-external-url";

// Prefer withUnistyles mappings over uniProps — lucide forwards unknown props to
// SVG <path> on web, which logs React DOM warnings for `uniProps`.
const ThemedExternalLinkForeground = withUnistyles(ExternalLink, (theme: Theme) => ({
  color: theme.colors.foreground,
}));
const ThemedGitPullRequestMerged = withUnistyles(GitPullRequest, (theme: Theme) => ({
  color: theme.colors.palette.purple[500],
}));
const ThemedGitPullRequestOpen = withUnistyles(GitPullRequest, (theme: Theme) => ({
  color: theme.colors.palette.green[500],
}));
const ThemedGitPullRequestClosed = withUnistyles(GitPullRequest, (theme: Theme) => ({
  color: theme.colors.palette.red[500],
}));

function PrStateIcon({ state, size }: { state: PrHint["state"]; size: number }) {
  switch (state) {
    case "merged":
      return <ThemedGitPullRequestMerged size={size} />;
    case "open":
      return <ThemedGitPullRequestOpen size={size} />;
    case "closed":
      return <ThemedGitPullRequestClosed size={size} />;
  }
}

function prBadgePressableStyle({ pressed }: PressableStateCallbackType) {
  return [styles.badge, pressed && styles.badgePressed];
}

export function PrBadge({ hint }: { hint: PrHint }) {
  const { t } = useTranslation();
  const [isHovered, setIsHovered] = useState(false);

  const handlePressIn = useCallback((event: GestureResponderEvent) => {
    event.stopPropagation();
  }, []);

  const handlePress = useCallback(
    (event: GestureResponderEvent) => {
      event.stopPropagation();
      void openExternalUrl(hint.url);
    },
    [hint.url],
  );

  const handleHoverIn = useCallback(() => setIsHovered(true), []);
  const handleHoverOut = useCallback(() => setIsHovered(false), []);

  const textStyle = isHovered ? [styles.text, styles.textHovered] : styles.text;
  const presentation = getForgePresentation(normalizeForge(hint.forge));

  return (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={t("workspace.git.pr.accessibility.pullRequest", {
        number: hint.number,
        context: presentation.changeRequestContext,
      })}
      hitSlop={4}
      onPressIn={handlePressIn}
      onPress={handlePress}
      onHoverIn={handleHoverIn}
      onHoverOut={handleHoverOut}
      style={prBadgePressableStyle}
    >
      {isHovered ? (
        <ThemedExternalLinkForeground size={12} />
      ) : (
        <PrStateIcon state={hint.state} size={12} />
      )}
      <Text style={textStyle} numberOfLines={1}>
        {presentation.numberPrefix}
        {hint.number}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create((theme) => ({
  badge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 2,
  },
  badgePressed: {
    opacity: 0.82,
  },
  text: {
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.normal,
    lineHeight: 14,
    color: theme.colors.foregroundMuted,
  },
  textHovered: {
    color: theme.colors.foreground,
  },
}));

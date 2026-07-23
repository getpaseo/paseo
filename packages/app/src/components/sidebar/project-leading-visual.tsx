import type { ReactNode } from "react";
import { ActivityIndicator, View, type ViewStyle } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { ChevronDown, ChevronRight, CircleAlert } from "lucide-react-native";
import { ProjectIconView } from "@/components/project-icon-view";
import { SyncedLoader } from "@/components/synced-loader";
import type { Theme } from "@/styles/theme";
import type { SidebarStateBucket } from "@/utils/sidebar-agent-state";
import { getProjectStatusBadgeContent } from "@/utils/project-status-badge-content";
import { projectIconPlaceholderLabelFromDisplayName } from "@/utils/project-display-name";

// Every surfaced status shares one badge shell, so the ring never changes size or position
// between states. Only the thing inside it changes.
const STATUS_BADGE_SIZE = 14;
const STATUS_BADGE_BORDER_WIDTH = 1;
// Centers the badge on the icon's bottom-right corner: half in, half out.
const STATUS_BADGE_OFFSET = -(STATUS_BADGE_SIZE / 2);
// Both glyphs must be EVEN. The shell's interior is 12pt (14 minus the 1pt ring on each side),
// so a centered glyph of size N sits at a (12 - N) / 2 offset — fractional for odd N, which the
// browser snaps to a device-pixel boundary and renders visibly off-center (an odd size measured
// 1.5 device px right and down at 3x, ~3px of asymmetry between opposite gaps). Even sizes
// divide the interior into whole pixels and land dead center with no correction.
//
// Lucide's circle-alert paints ~83% of its nominal size, so an alert of 10 draws a ~8.3pt circle
// against the 8pt dot — the two states read as the same-diameter disc.
const STATUS_BADGE_DOT_SIZE = 8;
const STATUS_BADGE_ALERT_SIZE = 10;
// SyncedLoader clamps its dot size at 2px, so sizes 5-10 all render the same 5x8 dot grid.
const STATUS_BADGE_LOADER_SIZE = 7;
// The dot-comet's 6 divs are geometrically centered, but the snake reads a hair right inside
// the round circle. This optical nudge (pt, leftward) lands its visual center on the circle
// center — the play-button-triangle trick. Dialed in visually: -0.67pt ≈ 2 device px left at
// 3x (a full -1pt / 3px read a touch too far left).
const STATUS_BADGE_LOADER_NUDGE_X = -0.67;

const ThemedActivityIndicator = withUnistyles(ActivityIndicator);
const ThemedCircleAlert = withUnistyles(CircleAlert);
const ThemedSyncedLoader = withUnistyles(SyncedLoader);

const foregroundMutedColorMapping = (theme: Theme) => ({
  color: theme.colors.foregroundMuted,
});
const amberColorMapping = (theme: Theme) => ({
  color: theme.colors.palette.amber[500],
});
const syncedLoaderColorMapping = (theme: Theme) => ({
  color:
    theme.colorScheme === "light"
      ? theme.colors.palette.amber[700]
      : theme.colors.palette.amber[500],
});

/**
 * Leading slot of a sidebar project row: chevron on hover, archive spinner while removing,
 * otherwise the project icon carrying the project's aggregate workspace status.
 */
export function ProjectLeadingVisual({
  displayName,
  iconDataUri,
  statusBucket,
  projectViewKey,
  chevron = null,
  showChevron = false,
  isArchiving = false,
}: {
  displayName: string;
  iconDataUri: string | null;
  /** Aggregate status of the project's workspaces; null when it shouldn't be surfaced. */
  statusBucket: SidebarStateBucket | null;
  projectViewKey: string;
  chevron?: "expand" | "collapse" | null;
  showChevron?: boolean;
  isArchiving?: boolean;
}) {
  const placeholderLabel = projectIconPlaceholderLabelFromDisplayName(displayName);
  const placeholderInitial = placeholderLabel.charAt(0).toUpperCase();

  if (showChevron && chevron !== null) {
    return (
      <View style={styles.projectLeadingVisualSlot}>
        <ProjectInlineChevron chevron={chevron} />
      </View>
    );
  }

  if (isArchiving) {
    return (
      <View style={styles.projectLeadingVisualSlot} testID="project-status-indicator-archiving">
        <ThemedActivityIndicator size={8} uniProps={foregroundMutedColorMapping} />
      </View>
    );
  }

  return (
    <ProjectStatusIndicator
      iconDataUri={iconDataUri}
      placeholderInitial={placeholderInitial}
      projectViewKey={projectViewKey}
      statusBucket={statusBucket}
    />
  );
}

// The project icon (the lettered box) is what marks a row as a *project* rather than a
// workspace, so it always stays. Status rides along as a corner badge instead of replacing
// the icon: "working" and "needs input" keep the same amber loader/alert glyph a workspace
// row uses, the quieter buckets get a dot, and "done" shows nothing. Every one of those sits
// in the identical ringed badge, so the badge reads as one fixed shell across all states.
export function ProjectStatusIndicator({
  iconDataUri,
  placeholderInitial,
  projectViewKey,
  statusBucket,
}: {
  iconDataUri: string | null;
  placeholderInitial: string;
  projectViewKey: string;
  statusBucket: SidebarStateBucket | null;
}) {
  return (
    <View
      style={styles.projectLeadingVisualSlot}
      testID={
        statusBucket && statusBucket !== "done"
          ? `project-status-indicator-${statusBucket}`
          : "project-icon-only"
      }
    >
      <ProjectIcon
        iconDataUri={iconDataUri}
        placeholderInitial={placeholderInitial}
        projectViewKey={projectViewKey}
      />
      <ProjectStatusBadge statusBucket={statusBucket} />
    </View>
  );
}

function ProjectStatusBadge({ statusBucket }: { statusBucket: SidebarStateBucket | null }) {
  const content = getProjectStatusBadgeContent(statusBucket);
  if (content === null) {
    return null;
  }

  return (
    <View style={styles.statusBadge} testID="project-status-badge">
      {renderProjectStatusBadgeContent(content)}
    </View>
  );
}

function renderProjectStatusBadgeContent(
  content: NonNullable<ReturnType<typeof getProjectStatusBadgeContent>>,
): ReactNode {
  switch (content.kind) {
    case "loader":
      // Nudged left a hair so the comet's visual center sits on the circle center (see the
      // nudge constant). The wrapper carries the transform; the loader itself is untouched.
      return (
        <View style={styles.runningLoaderNudge}>
          <ThemedSyncedLoader size={STATUS_BADGE_LOADER_SIZE} uniProps={syncedLoaderColorMapping} />
        </View>
      );
    case "alert":
      return <ThemedCircleAlert size={STATUS_BADGE_ALERT_SIZE} uniProps={amberColorMapping} />;
    case "dot":
      return <View testID="project-status-dot" style={getStatusDotColorStyle(content.bucket)} />;
  }
}

function ProjectIcon({
  iconDataUri,
  placeholderInitial,
  projectViewKey,
}: {
  iconDataUri: string | null;
  placeholderInitial: string;
  projectViewKey: string;
}) {
  return (
    <ProjectIconView
      iconDataUri={iconDataUri}
      initial={placeholderInitial}
      projectViewKey={projectViewKey}
      imageStyle={styles.projectIcon}
      fallbackStyle={styles.projectIconFallback}
      textStyle={styles.projectIconFallbackText}
    />
  );
}

function ProjectInlineChevron({ chevron }: { chevron: "expand" | "collapse" | null }) {
  if (chevron === null) {
    return null;
  }
  if (chevron === "collapse") {
    return <ChevronDown size={14} color="#9ca3af" />;
  }
  return <ChevronRight size={14} color="#9ca3af" />;
}

function getStatusDotColorStyle(bucket: "failed" | "attention"): ViewStyle {
  return bucket === "failed" ? styles.statusDotFailed : styles.statusDotAttention;
}

const styles = StyleSheet.create((theme) => {
  // Dot statuses sit *inside* the shell rather than replacing it, so "ready to review" and
  // "failed" carry the same ring as the loader and alert. The geometry is shared here and
  // baked into each colored variant so the style prop stays a single stable object.
  const statusDotBase = {
    width: STATUS_BADGE_DOT_SIZE,
    height: STATUS_BADGE_DOT_SIZE,
    borderRadius: theme.borderRadius.full,
  } as const;

  return {
    projectLeadingVisualSlot: {
      position: "relative",
      width: theme.iconSize.md,
      height: theme.iconSize.md,
      flexShrink: 0,
      alignItems: "center",
      justifyContent: "center",
    },
    projectIcon: {
      width: "100%",
      height: "100%",
      borderRadius: theme.borderRadius.sm,
    },
    projectIconFallback: {
      width: "100%",
      height: "100%",
      borderRadius: theme.borderRadius.sm,
      alignItems: "center",
      justifyContent: "center",
    },
    projectIconFallbackText: {
      fontSize: 9,
    },
    // The one shell every status shares. It straddles the icon's bottom-right corner (half in,
    // half out) so the lettered project box stays readable, and its ring is sidebar-colored so
    // the badge separates from the icon underneath rather than blending into it.
    statusBadge: {
      position: "absolute",
      right: STATUS_BADGE_OFFSET,
      bottom: STATUS_BADGE_OFFSET,
      width: STATUS_BADGE_SIZE,
      height: STATUS_BADGE_SIZE,
      borderRadius: theme.borderRadius.full,
      backgroundColor: theme.colors.surface0,
      borderWidth: STATUS_BADGE_BORDER_WIDTH,
      borderColor: theme.colors.surfaceSidebar,
      alignItems: "center",
      justifyContent: "center",
      overflow: "hidden",
    },
    // Optical-centering nudge for the running dot-comet (see the nudge constant).
    runningLoaderNudge: {
      transform: [{ translateX: STATUS_BADGE_LOADER_NUDGE_X }],
    },
    statusDotFailed: {
      ...statusDotBase,
      backgroundColor: theme.colors.palette.red[500],
    },
    statusDotAttention: {
      ...statusDotBase,
      backgroundColor: theme.colors.palette.green[500],
    },
  };
});

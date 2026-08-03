import { ActivityIndicator, View, type ViewStyle } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { ChevronDown, ChevronRight, CircleAlert } from "lucide-react-native";
import { ProjectIconView } from "@/components/project-icon-view";
import { PulsingStatusDot } from "@/components/sidebar/pulsing-status-dot";
import { STATUS_BUCKET_LABELS } from "@/hooks/sidebar-status-view-model";
import type { Theme } from "@/styles/theme";
import type { SidebarStateBucket } from "@/utils/sidebar-agent-state";
import {
  getProjectStatusBadgeContent,
  type ProjectStatusBadgeContent,
  type ProjectStatusBadgeDotBucket,
} from "@/utils/project-status-badge-content";
import { projectIconPlaceholderLabelFromDisplayName } from "@/utils/project-display-name";
import { getStatusDotColor } from "@/utils/status-dot-color";

// Every surfaced status shares one badge shell, so the badge never changes size or position
// between states. Only the thing inside it changes.
const STATUS_BADGE_SIZE = 14;
const STATUS_BADGE_BORDER_WIDTH = 1;
// How far the badge overhangs the icon's bottom-right corner. Well short of half the badge:
// centered on the corner it reads as hanging off the icon rather than sitting on it, and the
// sidebar row has no padding there to absorb the overhang.
const STATUS_BADGE_OFFSET = -5;
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
// Matches the workspace title's lineHeight (sidebar-workspace-row-content's
// workspaceBranchText) so the icon centers on the title rather than floating above it.
const LEADING_SLOT_HEIGHT = 20;

const ThemedActivityIndicator = withUnistyles(ActivityIndicator);
const ThemedCircleAlert = withUnistyles(CircleAlert);

const foregroundMutedColorMapping = (theme: Theme) => ({
  color: theme.colors.foregroundMuted,
});
const amberColorMapping = (theme: Theme) => ({
  color: theme.colors.palette.amber[500],
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
      displayName={displayName}
      projectViewKey={projectViewKey}
      statusBucket={statusBucket}
    />
  );
}

// The project icon (the lettered box) is what marks a row as a *project* rather than a
// workspace, so it always stays and status annotates it instead of replacing it. Every
// surfaced bucket lands in the identical corner badge — an amber alert glyph for needs_input,
// a colored disc for the rest, nothing for done — so the badge reads as one fixed shell and
// only its contents change.
export function ProjectStatusIndicator({
  iconDataUri,
  displayName,
  projectViewKey,
  statusBucket,
  loading = false,
  testID,
}: {
  iconDataUri: string | null;
  displayName: string;
  projectViewKey: string;
  statusBucket: SidebarStateBucket | null;
  loading?: boolean;
  testID?: string;
}) {
  const placeholderInitial = projectIconPlaceholderLabelFromDisplayName(displayName)
    .charAt(0)
    .toUpperCase();
  // A row that's still starting up and a row that's working are both "busy", and at 8pt
  // there's no room to draw the difference — so `loading` just resolves to the running bucket
  // and they share one badge.
  const badgeBucket = loading ? "running" : statusBucket;
  const badgeContent = getProjectStatusBadgeContent(badgeBucket);

  return (
    <View
      style={styles.projectLeadingVisualSlot}
      testID={
        testID ??
        (statusBucket && statusBucket !== "done"
          ? `project-status-indicator-${statusBucket}`
          : "project-icon-only")
      }
    >
      <View style={styles.projectIconBox}>
        <ProjectIcon
          iconDataUri={iconDataUri}
          placeholderInitial={placeholderInitial}
          projectViewKey={projectViewKey}
        />
        {badgeContent === null || badgeBucket === null ? null : (
          <ProjectStatusBadge content={badgeContent} statusBucket={badgeBucket} />
        )}
      </View>
    </View>
  );
}

function ProjectStatusBadge({
  content,
  statusBucket,
}: {
  content: ProjectStatusBadgeContent;
  statusBucket: SidebarStateBucket;
}) {
  return (
    <View
      role="status"
      accessibilityLabel={STATUS_BUCKET_LABELS[statusBucket]}
      style={styles.statusBadge}
      testID="project-status-badge"
    >
      {content.kind === "alert" ? (
        <ThemedCircleAlert size={STATUS_BADGE_ALERT_SIZE} uniProps={amberColorMapping} />
      ) : (
        <ProjectStatusDot bucket={content.bucket} />
      )}
    </View>
  );
}

function ProjectStatusDot({ bucket }: { bucket: ProjectStatusBadgeDotBucket }) {
  if (bucket !== "running") {
    return <View testID="project-status-dot" style={getStatusDotColorStyle(bucket)} />;
  }
  return <PulsingStatusDot testID="project-status-dot" style={styles.statusDotRunning} />;
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

function getStatusDotColorStyle(
  bucket: Exclude<ProjectStatusBadgeDotBucket, "running">,
): ViewStyle {
  return bucket === "failed" ? styles.statusDotFailed : styles.statusDotAttention;
}

const styles = StyleSheet.create((theme) => {
  // Dot statuses sit *inside* the shell rather than replacing it, so they carry the same ring
  // the alert does. The geometry is shared here and baked into each colored variant so the
  // style prop stays a single stable object; the colors come from the one bucket-to-color map
  // so this badge can't drift from the status dots everywhere else.
  const statusDot = (bucket: ProjectStatusBadgeDotBucket) =>
    ({
      width: STATUS_BADGE_DOT_SIZE,
      height: STATUS_BADGE_DOT_SIZE,
      borderRadius: theme.borderRadius.full,
      backgroundColor: getStatusDotColor({ theme, bucket }) ?? undefined,
    }) as const;

  return {
    // The slot is as tall as the title's line box, not as tall as the icon, and centers the
    // icon inside it. Rows lay their leading visual out with alignItems:flex-start, so a
    // 16pt slot next to a 20pt line box puts the icon 2pt above the title and the kebab —
    // which is why the workspace status indicator is also 20 tall. Keep the two in step.
    projectLeadingVisualSlot: {
      width: theme.iconSize.md,
      height: LEADING_SLOT_HEIGHT,
      flexShrink: 0,
      alignItems: "center",
      justifyContent: "center",
    },
    // Anchors the corner badge to the icon rather than to the taller slot.
    projectIconBox: {
      position: "relative",
      width: theme.iconSize.md,
      height: theme.iconSize.md,
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
    // The shell the alert and dot statuses share. It straddles the icon's bottom-right corner
    // (half in, half out) so the lettered project box stays readable, and its ring is
    // sidebar-colored so the badge separates from the icon underneath rather than blending in.
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
    statusDotRunning: statusDot("running"),
    statusDotFailed: statusDot("failed"),
    statusDotAttention: statusDot("attention"),
  };
});

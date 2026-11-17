import { memo, useCallback, useMemo, useState } from "react";
import { Text, View } from "react-native";
import { ChevronDown, ChevronRight, ExternalLink, Gift } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet, withUnistyles } from "react-native-unistyles";

import {
  AdaptiveModalSheet,
  SheetHeaderIconButton,
  type SheetHeader,
} from "@/components/adaptive-modal-sheet";
import { MarkdownRenderer } from "@/components/markdown/renderer";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { PressHighlight } from "@/components/ui/press-highlight";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { StatusBadge } from "@/components/ui/status-badge";
import { ICON_SIZE, type Theme } from "@/styles/theme";
import { resolveAppVersion } from "@/utils/app-version";
import { openExternalUrl } from "@/utils/open-external-url";
import { useChangelog, type ChangelogState } from "./changelog-source";
import { revealGroups, type ChangelogReleaseGroup } from "./release-groups";
import { useRevealedReleases } from "./use-revealed-releases";
import {
  formatChangelogDate,
  type ChangelogRelease,
  type ChangelogSection,
} from "./parse-changelog";

const WEBSITE_CHANGELOG_URL = "https://paseo.sh/changelog";

const ThemedGift = withUnistyles(Gift);
const ThemedLoadingSpinner = withUnistyles(LoadingSpinner);
const ThemedChevronDown = withUnistyles(ChevronDown);
const ThemedChevronRight = withUnistyles(ChevronRight);
const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const sheetLeadingIcon = <ThemedGift size={ICON_SIZE.md} uniProps={mutedColorMapping} />;

interface ChangelogSheetProps {
  visible: boolean;
  onClose: () => void;
}

export function ChangelogSheet({ visible, onClose }: ChangelogSheetProps) {
  const { t } = useTranslation();
  const { state, reload } = useChangelog(visible);
  const { count, showMore } = useRevealedReleases(visible && state.status === "ready");

  const handleOpenWebsite = useCallback(() => {
    void openExternalUrl(WEBSITE_CHANGELOG_URL);
  }, []);

  const header: SheetHeader = useMemo(
    () => ({
      title: t("changelog.title"),
      leading: sheetLeadingIcon,
      actions: (
        <SheetHeaderIconButton
          icon={ExternalLink}
          label={t("changelog.openWebsite")}
          onPress={handleOpenWebsite}
          testID="changelog-open-website"
        />
      ),
    }),
    [handleOpenWebsite, t],
  );

  return (
    <AdaptiveModalSheet
      header={header}
      visible={visible}
      onClose={onClose}
      snapPoints={SNAP_POINTS}
      desktopMaxWidth={620}
      desktopHeight="85%"
      testID="changelog-sheet"
    >
      <ChangelogBody state={state} shownItems={count} onShowMore={showMore} onRetry={reload} />
    </AdaptiveModalSheet>
  );
}

const SNAP_POINTS = ["85%", "95%"];

interface ChangelogBodyProps {
  state: ChangelogState;
  shownItems: number;
  onShowMore: () => void;
  onRetry: () => void;
}

function ChangelogBody({ state, shownItems, onShowMore, onRetry }: ChangelogBodyProps) {
  const { t } = useTranslation();
  const appVersion = useMemo(() => resolveAppVersion()?.replace(/^v/i, "") ?? null, []);

  if (state.status === "loading") {
    return (
      <View style={styles.centered}>
        <ThemedLoadingSpinner size="large" uniProps={mutedColorMapping} />
      </View>
    );
  }

  if (state.status === "error") {
    return (
      <View style={styles.centered}>
        <Alert
          size="md"
          variant="error"
          title={t("changelog.error.title")}
          description={t("changelog.error.description")}
          testID="changelog-error"
        >
          <Button variant="outline" onPress={onRetry} testID="changelog-retry">
            {t("common.actions.retry")}
          </Button>
        </Alert>
      </View>
    );
  }

  const revealed = revealGroups(state.groups, shownItems);

  return (
    <View style={styles.groupList}>
      {revealed.groups.map((group) => (
        <ReleaseGroupView key={group.version} group={group} installedVersion={appVersion} />
      ))}
      {revealed.hasMore ? (
        <Button
          variant="ghost"
          onPress={onShowMore}
          style={styles.showMore}
          testID="changelog-show-more"
        >
          {t("changelog.showMore")}
        </Button>
      ) : null}
    </View>
  );
}

interface ReleaseGroupViewProps {
  group: ChangelogReleaseGroup;
  installedVersion: string | null;
}

/**
 * A minor version: its highlights, then one closed row per version of it,
 * newest first, each opening to that version's changes. A minor without
 * highlights has nothing to stand in for its versions, so it shows them as it
 * always did.
 */
const ReleaseGroupView = memo(function ReleaseGroupView({
  group,
  installedVersion,
}: ReleaseGroupViewProps) {
  if (!group.highlights) {
    return (
      <View style={styles.releaseList} testID={`changelog-release-group-${group.version}`}>
        {group.releases.map((release) => (
          <ReleaseView
            key={`${release.version}:${release.date}`}
            release={release}
            isCurrent={release.version === installedVersion}
          />
        ))}
      </View>
    );
  }

  return (
    <View style={styles.release} testID={`changelog-release-group-${group.version}`}>
      <View style={styles.releaseHeading}>
        <Text style={styles.version}>{group.version}</Text>
      </View>
      <MarkdownRenderer text={group.highlights} compact />
      <View style={styles.versionRows}>
        {group.releases.map((release) => (
          <VersionRow
            key={`${release.version}:${release.date}`}
            release={release}
            isCurrent={release.version === installedVersion}
          />
        ))}
      </View>
    </View>
  );
});

interface VersionRowProps {
  release: ChangelogRelease;
  isCurrent: boolean;
}

/** One version of a minor, closed until the reader opens it to its changes. */
const VersionRow = memo(function VersionRow({ release, isCurrent }: VersionRowProps) {
  const { t } = useTranslation();
  const date = formatChangelogDate(release.date);
  const [open, setOpen] = useState(false);
  const toggle = useCallback(() => setOpen((value) => !value), []);
  const accessibilityState = useMemo(() => ({ expanded: open }), [open]);
  const Chevron = open ? ThemedChevronDown : ThemedChevronRight;

  return (
    <View style={styles.versionRow} testID={`changelog-release-${release.version}`}>
      <PressHighlight
        accessibilityRole="button"
        accessibilityState={accessibilityState}
        onPress={toggle}
        style={styles.versionRowHeading}
      >
        <Chevron size={ICON_SIZE.sm} uniProps={mutedColorMapping} />
        <Text style={styles.versionRowLabel}>{release.version}</Text>
        {isCurrent ? <StatusBadge label={t("changelog.installed")} /> : null}
        <View style={styles.headingSpacer} />
        {date ? <Text style={styles.date}>{date}</Text> : null}
      </PressHighlight>
      {open ? (
        <View style={styles.versionRowBody}>
          {release.highlights ? <MarkdownRenderer text={release.highlights} compact /> : null}
          <ReleaseSections sections={release.sections} />
        </View>
      ) : null}
    </View>
  );
});

interface ReleaseViewProps {
  release: ChangelogRelease;
  isCurrent: boolean;
}

/**
 * A release that has highlights shows only them until the reader asks for the
 * sections, which are the full record. A release without highlights has nothing
 * to stand in for its sections, so it shows them as it always did.
 */
const ReleaseView = memo(function ReleaseView({ release, isCurrent }: ReleaseViewProps) {
  const { t } = useTranslation();
  const date = formatChangelogDate(release.date);
  const [showingAllChanges, setShowingAllChanges] = useState(false);
  const toggleAllChanges = useCallback(() => setShowingAllChanges((value) => !value), []);
  const allChangesState = useMemo(() => ({ expanded: showingAllChanges }), [showingAllChanges]);
  const hasHighlights = release.highlights.length > 0;
  const showsSections = !hasHighlights || showingAllChanges;

  return (
    <View style={styles.release} testID={`changelog-release-${release.version}`}>
      <View style={styles.releaseHeading}>
        <Text style={styles.version}>{release.version}</Text>
        {isCurrent ? <StatusBadge label={t("changelog.installed")} /> : null}
        <View style={styles.headingSpacer} />
        {date ? <Text style={styles.date}>{date}</Text> : null}
      </View>
      {hasHighlights ? <MarkdownRenderer text={release.highlights} compact /> : null}
      {hasHighlights && release.sections.length > 0 ? (
        <Button
          variant="ghost"
          style={styles.allChangesToggle}
          accessibilityState={allChangesState}
          onPress={toggleAllChanges}
        >
          {t(showingAllChanges ? "changelog.hideAllChanges" : "changelog.showAllChanges")}
        </Button>
      ) : null}
      {showsSections ? <ReleaseSections sections={release.sections} /> : null}
    </View>
  );
});

function ReleaseSections({ sections }: { sections: readonly ChangelogSection[] }) {
  return keyChangelogSections(sections).map(({ key, section }) => (
    <View key={key} style={styles.section}>
      {section.title ? <Text style={styles.sectionTitle}>{section.title}</Text> : null}
      {section.body ? <MarkdownRenderer text={section.body} compact /> : null}
    </View>
  ));
}

/** A release can repeat a section title; the occurrence keeps the key stable. */
function keyChangelogSections(
  sections: readonly ChangelogSection[],
): { key: string; section: ChangelogSection }[] {
  const seen = new Map<string, number>();
  return sections.map((section) => {
    const occurrence = seen.get(section.title) ?? 0;
    seen.set(section.title, occurrence + 1);
    return { key: `${section.title}:${occurrence}`, section };
  });
}

const styles = StyleSheet.create((theme) => ({
  centered: {
    flex: 1,
    minHeight: 160,
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[3],
  },
  groupList: {
    gap: theme.spacing[8],
    paddingBottom: theme.spacing[4],
  },
  releaseList: {
    gap: theme.spacing[8],
  },
  versionRows: {
    gap: theme.spacing[1],
  },
  versionRow: {
    gap: theme.spacing[3],
  },
  versionRowHeading: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingVertical: theme.spacing[2],
  },
  versionRowLabel: {
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
  },
  versionRowBody: {
    gap: theme.spacing[4],
    paddingBottom: theme.spacing[3],
  },
  release: {
    gap: theme.spacing[4],
  },
  releaseHeading: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingBottom: theme.spacing[2],
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: theme.colors.border,
  },
  headingSpacer: {
    flex: 1,
  },
  version: {
    fontSize: theme.fontSize.lg,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
  },
  date: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  section: {
    gap: theme.spacing[2],
  },
  sectionTitle: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foregroundMuted,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  // Flush with the highlights above it, so the label's ink sits on their rail.
  allChangesToggle: {
    alignSelf: "flex-start",
    paddingHorizontal: 0,
    borderWidth: 0,
  },
  showMore: {
    alignSelf: "center",
  },
}));

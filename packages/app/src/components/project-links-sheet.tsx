import { useCallback, useMemo } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { AdaptiveModalSheet, type SheetHeader } from "@/components/adaptive-modal-sheet";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { useToast } from "@/contexts/toast-context";
import {
  isValidLocalProjectLink,
  projectLinkPlacementKey,
  type LocalProjectLink,
  type ProjectLinkPlacement,
  type ProjectLinkSuggestion,
} from "@/projects/local-project-links";
import { useLocalProjectLinksStore } from "@/projects/local-project-links-store";

export interface ProjectLinksSheetProps {
  visible: boolean;
  onClose: () => void;
  placements: readonly ProjectLinkPlacement[];
  suggestions: readonly ProjectLinkSuggestion[];
}

/** Device-local link management. Git facts are displayed before a local grouping is changed. */
export function ProjectLinksSheet({
  visible,
  onClose,
  placements,
  suggestions,
}: ProjectLinksSheetProps) {
  const { t } = useTranslation();
  const toast = useToast();
  const links = useLocalProjectLinksStore((state) => state.links);
  const linkProjects = useLocalProjectLinksStore((state) => state.linkProjects);
  const unlinkProject = useLocalProjectLinksStore((state) => state.unlinkProject);
  const placementsByKey = useMemo(
    () => new Map(placements.map((placement) => [projectLinkPlacementKey(placement), placement])),
    [placements],
  );
  const header = useMemo<SheetHeader>(
    () => ({ title: t("settings.projectLinks.sheet.title") }),
    [t],
  );
  const footer = useMemo(
    () => (
      <Button onPress={onClose} variant="ghost" size="md" testID="project-links-close">
        {t("common.actions.close")}
      </Button>
    ),
    [onClose, t],
  );

  const handleLink = useCallback(
    (suggestion: ProjectLinkSuggestion) => {
      linkProjects({
        members: suggestion.placements.map(({ serverId, projectId }) => ({ serverId, projectId })),
        identity: suggestion.identity,
      });
      toast.show(t("settings.projectLinks.toasts.linked"), { variant: "success" });
    },
    [linkProjects, t, toast],
  );

  const handleUnlink = useCallback(
    (placement: Pick<ProjectLinkPlacement, "serverId" | "projectId">) => {
      unlinkProject(placement);
      toast.show(t("settings.projectLinks.toasts.unlinked"), { variant: "success" });
    },
    [t, toast, unlinkProject],
  );

  return (
    <AdaptiveModalSheet
      visible={visible}
      header={header}
      onClose={onClose}
      testID="project-links-sheet"
      desktopMaxWidth={620}
      footer={footer}
    >
      <View style={styles.content}>
        <Alert
          variant="info"
          description={t("settings.projectLinks.sheet.deviceOnly")}
          testID="project-links-device-only"
        />

        {suggestions.length > 0 ? (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>{t("settings.projectLinks.sheet.matchesTitle")}</Text>
            <Text style={styles.sectionDescription}>
              {t("settings.projectLinks.sheet.matchesDescription")}
            </Text>
            {suggestions.map((suggestion) => (
              <ProjectLinkSuggestionCard
                key={JSON.stringify(suggestion.placements.map(projectLinkPlacementKey))}
                suggestion={suggestion}
                onLink={handleLink}
              />
            ))}
          </View>
        ) : null}

        {links.length > 0 ? (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>{t("settings.projectLinks.sheet.linkedTitle")}</Text>
            {links.map((link) => (
              <LinkedProjectCard
                key={link.id}
                link={link}
                placementsByKey={placementsByKey}
                onUnlink={handleUnlink}
              />
            ))}
          </View>
        ) : null}

        {suggestions.length === 0 && links.length === 0 ? (
          <Alert
            title={t("settings.projectLinks.sheet.noMatchesTitle")}
            description={t("settings.projectLinks.sheet.noMatchesDescription")}
            testID="project-links-no-matches"
          />
        ) : null}
      </View>
    </AdaptiveModalSheet>
  );
}

function ProjectLinkSuggestionCard({
  suggestion,
  onLink,
}: {
  suggestion: ProjectLinkSuggestion;
  onLink: (suggestion: ProjectLinkSuggestion) => void;
}) {
  const { t } = useTranslation();
  const handleLink = useCallback(() => onLink(suggestion), [onLink, suggestion]);
  return (
    <View style={styles.card} testID="project-link-suggestion">
      <ProjectIdentityRows
        remoteDisplay={
          suggestion.placements[0]?.identity?.remoteDisplay ?? suggestion.identity.repository
        }
        subdirectory={suggestion.identity.subdirectory}
      />
      <View style={styles.hostRows}>
        {suggestion.placements.map((placement) => (
          <ProjectPlacementRow key={projectLinkPlacementKey(placement)} placement={placement} />
        ))}
      </View>
      <Button
        onPress={handleLink}
        variant="outline"
        size="sm"
        testID={`project-link-${suggestion.placements.map(projectLinkPlacementKey).join("-")}`}
      >
        {t("settings.projectLinks.sheet.linkProjects", { count: suggestion.placements.length })}
      </Button>
    </View>
  );
}

function LinkedProjectCard({
  link,
  placementsByKey,
  onUnlink,
}: {
  link: LocalProjectLink;
  placementsByKey: ReadonlyMap<string, ProjectLinkPlacement>;
  onUnlink: (placement: Pick<ProjectLinkPlacement, "serverId" | "projectId">) => void;
}) {
  const { t } = useTranslation();
  const valid = isValidLocalProjectLink(link, placementsByKey);
  return (
    <View style={styles.card} testID={`project-link-${link.id}`}>
      <ProjectIdentityRows
        remoteDisplay={link.identity.repository}
        subdirectory={link.identity.subdirectory}
      />
      {!valid ? (
        <Alert
          variant="warning"
          title={t("settings.projectLinks.sheet.needsReviewTitle")}
          description={t("settings.projectLinks.sheet.needsReviewDescription")}
        />
      ) : null}
      <View style={styles.hostRows}>
        {link.members.map((member) => {
          const placement = placementsByKey.get(projectLinkPlacementKey(member));
          return (
            <LinkedProjectMember
              key={projectLinkPlacementKey(member)}
              member={member}
              placement={placement ?? null}
              onUnlink={onUnlink}
            />
          );
        })}
      </View>
    </View>
  );
}

function LinkedProjectMember({
  member,
  placement,
  onUnlink,
}: {
  member: Pick<ProjectLinkPlacement, "serverId" | "projectId">;
  placement: ProjectLinkPlacement | null;
  onUnlink: (placement: Pick<ProjectLinkPlacement, "serverId" | "projectId">) => void;
}) {
  const { t } = useTranslation();
  const handleUnlink = useCallback(() => onUnlink(member), [member, onUnlink]);
  return (
    <View style={styles.linkedHostRow}>
      {placement ? (
        <ProjectPlacementRow placement={placement} />
      ) : (
        <View style={styles.missingPlacement}>
          <Text style={styles.hostName}>{member.serverId}</Text>
          <Text style={styles.missingText}>
            {t("settings.projectLinks.sheet.projectUnavailable")}
          </Text>
        </View>
      )}
      <Button
        onPress={handleUnlink}
        variant="ghost"
        size="sm"
        testID={`project-unlink-${projectLinkPlacementKey(member)}`}
      >
        {t("settings.projectLinks.sheet.unlink")}
      </Button>
    </View>
  );
}

function ProjectIdentityRows({
  remoteDisplay,
  subdirectory,
}: {
  remoteDisplay: string;
  subdirectory: string;
}) {
  const { t } = useTranslation();
  return (
    <View style={styles.identityRows}>
      <LabelValue label={t("settings.projectLinks.sheet.remote")} value={remoteDisplay} />
      <LabelValue
        label={t("settings.projectLinks.sheet.subdirectory")}
        value={subdirectory || "."}
      />
    </View>
  );
}

function ProjectPlacementRow({ placement }: { placement: ProjectLinkPlacement }) {
  const { t } = useTranslation();
  return (
    <View style={styles.placementRow}>
      <Text style={styles.hostName} numberOfLines={1}>
        {placement.serverName}
      </Text>
      <LabelValue label={t("settings.projectLinks.sheet.path")} value={placement.projectRootPath} />
      {placement.identity ? (
        <LabelValue
          label={t("settings.projectLinks.sheet.remote")}
          value={placement.identity.remoteDisplay}
        />
      ) : null}
    </View>
  );
}

function LabelValue({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.labelValue}>
      <Text style={styles.label}>{label}</Text>
      <Text style={styles.value} selectable numberOfLines={2}>
        {value}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  content: {
    gap: theme.spacing[4],
    paddingBottom: theme.spacing[2],
  },
  section: {
    gap: theme.spacing[2],
  },
  sectionTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
  },
  sectionDescription: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  card: {
    gap: theme.spacing[3],
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.xl,
    borderWidth: theme.borderWidth[1],
    padding: theme.spacing[3],
  },
  identityRows: {
    gap: theme.spacing[2],
  },
  hostRows: {
    gap: theme.spacing[2],
  },
  linkedHostRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: theme.spacing[2],
  },
  placementRow: {
    flex: 1,
    minWidth: 0,
    gap: theme.spacing[1],
  },
  missingPlacement: {
    flex: 1,
    minWidth: 0,
    gap: theme.spacing[1],
  },
  hostName: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  missingText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  labelValue: {
    gap: 2,
  },
  label: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  value: {
    color: theme.colors.foreground,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.sm,
  },
}));

import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { SettingsDetailRow } from "@/components/settings/detail-row";
import { ProjectLinksSheet } from "@/components/project-links-sheet";
import {
  scopeProjectLinks,
  type ProjectLinkPlacement,
  type ProjectLinkPlacementRef,
  type ProjectLinkSuggestion,
} from "@/projects/local-project-links";
import { useLocalProjectLinksStore } from "@/projects/local-project-links-store";
import { settingsStyles } from "@/styles/settings";

interface ProjectLinksEntryProps {
  serverId: string;
  projectId?: string;
  placements?: readonly ProjectLinkPlacement[];
  suggestions?: readonly ProjectLinkSuggestion[];
}

export function ProjectLinksEntry({
  serverId,
  projectId,
  placements = [],
  suggestions = [],
}: ProjectLinksEntryProps) {
  const { t } = useTranslation();
  const links = useLocalProjectLinksStore((state) => state.links);
  const [isOpen, setIsOpen] = useState(false);
  const open = useCallback(() => setIsOpen(true), []);
  const close = useCallback(() => setIsOpen(false), []);
  const matchesScope = (placement: ProjectLinkPlacementRef) =>
    placement.serverId === serverId &&
    (projectId === undefined || placement.projectId === projectId);
  const { suggestions: scopedSuggestions, links: scopedLinks } = scopeProjectLinks(
    { suggestions, links },
    matchesScope,
  );
  const hint =
    scopedSuggestions.length > 0
      ? t("settings.projectLinks.entry.matches", { count: scopedSuggestions.length })
      : t(
          scopedLinks.length > 0
            ? "settings.projectLinks.entry.savedLinks"
            : "settings.projectLinks.entry.hint",
        );

  return (
    <View style={settingsStyles.card}>
      <SettingsDetailRow
        label={t(
          projectId === undefined
            ? "settings.projectLinks.sheet.title"
            : "settings.projectLinks.entry.linkProjects",
        )}
        hint={hint}
        onPress={open}
        testID="project-links-entry"
      />
      <ProjectLinksSheet
        visible={isOpen}
        onClose={close}
        placements={placements}
        suggestions={scopedSuggestions}
        links={scopedLinks}
      />
    </View>
  );
}

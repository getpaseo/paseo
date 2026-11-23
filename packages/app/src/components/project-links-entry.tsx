import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { SettingsDetailRow } from "@/components/settings/detail-row";
import { ProjectLinksSheet } from "@/components/project-links-sheet";
import {
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
  const scopedSuggestions = suggestions.filter((suggestion) =>
    suggestion.placements.some(matchesScope),
  );
  const scopedLinks = links.filter((link) => link.members.some(matchesScope));

  return (
    <View style={settingsStyles.card}>
      <SettingsDetailRow
        label={t("settings.projectLinks.sheet.title")}
        hint={t(
          scopedSuggestions.length > 0
            ? "settings.projectLinks.entry.matches"
            : "settings.projectLinks.entry.hint",
        )}
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

import { Archive } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { withUnistyles } from "react-native-unistyles";
import { StatusBadge } from "@/components/ui/status-badge";

const ThemedArchive = withUnistyles(Archive, (theme) => ({
  size: theme.fontSize.sm,
  color: theme.colors.foregroundMuted,
}));

const ARCHIVE_ICON = <ThemedArchive />;

/** Marks a session or workspace the user archived, wherever archived items are listed. */
export function ArchivedBadge() {
  const { t } = useTranslation();
  return <StatusBadge label={t("agentList.badges.archived")} leading={ARCHIVE_ICON} />;
}

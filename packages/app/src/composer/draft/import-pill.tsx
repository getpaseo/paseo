import { useTranslation } from "react-i18next";
import { withUnistyles } from "react-native-unistyles";
import { Import as ImportIcon } from "lucide-react-native";
import type { Theme } from "@/styles/theme";
import { ComposerDraftActionPill } from "./action-pill";

const ThemedImportIcon = withUnistyles(ImportIcon);
const iconColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const importIcon = <ThemedImportIcon size={14} uniProps={iconColorMapping} />;

interface ComposerImportPillProps {
  onPress: () => void;
  disabled?: boolean;
}

export function ComposerImportPill({ onPress, disabled = false }: ComposerImportPillProps) {
  const { t } = useTranslation();
  const label = t("importSession.title");
  return (
    <ComposerDraftActionPill
      testID="composer-import-agent-pill"
      label={label}
      icon={importIcon}
      onPress={onPress}
      disabled={disabled}
    />
  );
}

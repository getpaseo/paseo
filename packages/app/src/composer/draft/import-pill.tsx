import { useCallback, useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Import as ImportIcon } from "lucide-react-native";
import { composerPillStyles } from "@/composer/pill-styles";
import type { Theme } from "@/styles/theme";

const ThemedImportIcon = withUnistyles(ImportIcon);
const iconColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

interface ComposerImportPillProps {
  onPress: () => void;
  disabled?: boolean;
}

export function ComposerImportPill({ onPress, disabled = false }: ComposerImportPillProps) {
  const { t } = useTranslation();
  const [isHovered, setIsHovered] = useState(false);
  const handleHoverIn = useCallback(() => setIsHovered(true), []);
  const handleHoverOut = useCallback(() => setIsHovered(false), []);
  const bodyStyle = useMemo(
    () => [composerPillStyles.body, isHovered && composerPillStyles.bodyActive],
    [isHovered],
  );
  const labelStyle = useMemo(
    () => [composerPillStyles.label, isHovered && composerPillStyles.labelActive],
    [isHovered],
  );
  return (
    <View style={styles.row}>
      <Pressable
        testID="composer-import-agent-pill"
        accessibilityRole="button"
        accessibilityLabel={t("importSession.title")}
        onPress={onPress}
        disabled={disabled}
        onHoverIn={handleHoverIn}
        onHoverOut={handleHoverOut}
        style={bodyStyle}
      >
        <ThemedImportIcon size={14} uniProps={iconColorMapping} />
        <Text style={labelStyle} numberOfLines={1}>
          {t("importSession.title")}
        </Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create(() => ({
  row: {
    flexDirection: "row",
  },
}));

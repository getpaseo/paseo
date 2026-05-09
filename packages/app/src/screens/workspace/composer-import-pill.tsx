import { useCallback, useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Import as ImportIcon } from "lucide-react-native";
import type { Theme } from "@/styles/theme";

const ThemedImportIcon = withUnistyles(ImportIcon);
const iconColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

interface ComposerImportPillProps {
  onPress: () => void;
  disabled?: boolean;
}

export function ComposerImportPill({ onPress, disabled = false }: ComposerImportPillProps) {
  const [isHovered, setIsHovered] = useState(false);
  const handleHoverIn = useCallback(() => setIsHovered(true), []);
  const handleHoverOut = useCallback(() => setIsHovered(false), []);
  const bodyStyle = useMemo(() => [styles.body, isHovered && styles.bodyHovered], [isHovered]);
  return (
    <View style={styles.row}>
      <Pressable
        testID="composer-import-agent-pill"
        accessibilityRole="button"
        accessibilityLabel="Import agent"
        onPress={onPress}
        disabled={disabled}
        onHoverIn={handleHoverIn}
        onHoverOut={handleHoverOut}
        style={bodyStyle}
      >
        <ThemedImportIcon size={14} uniProps={iconColorMapping} />
        <Text style={styles.label} numberOfLines={1}>
          Import agent
        </Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  row: {
    flexDirection: "row",
  },
  body: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.borderAccent,
    backgroundColor: theme.colors.surface1,
  },
  bodyHovered: {
    backgroundColor: theme.colors.surface2,
  },
  label: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
}));

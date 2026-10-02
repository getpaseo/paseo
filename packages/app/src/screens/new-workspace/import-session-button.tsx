import { Import } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { Button } from "@/components/ui/button";

/**
 * The new workspace screen's way into Import session: a ghost button at the top on compact
 * layouts, an outlined pill under the composer otherwise. Both are muted until hovered.
 */
export function ImportSessionButton({
  compact,
  onPress,
}: {
  compact: boolean;
  onPress: () => void;
}) {
  const { t } = useTranslation();
  return (
    <View style={compact ? styles.compact : styles.wide}>
      <Button
        // Ghost for its muted text that turns foreground on hover; the pill adds the outline.
        variant="ghost"
        size="sm"
        leftIcon={Import}
        onPress={onPress}
        style={compact ? null : styles.pill}
        testID="new-workspace-import-session"
      >
        {t("importSession.title")}
      </Button>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  compact: {
    alignItems: "flex-start",
  },
  // The composer sits spacing[4] in from the dock and leaves spacing[4] below itself; the pill's
  // border lines up with the composer's border.
  wide: {
    alignItems: "flex-start",
    paddingHorizontal: theme.spacing[4],
  },
  pill: {
    borderRadius: theme.borderRadius.full,
    borderColor: theme.colors.borderAccent,
  },
}));

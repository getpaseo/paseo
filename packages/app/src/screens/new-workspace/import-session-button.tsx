import { Import } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import { chatStyles } from "@/styles/chat";

/**
 * The new workspace screen's way into Import session: a ghost button at the top on compact
 * layouts, a secondary text action under the composer otherwise.
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
    <View style={compact ? styles.compact : [chatStyles.rail, styles.wide]}>
      <Button
        variant="ghost"
        size="sm"
        leftIcon={Import}
        onPress={onPress}
        testID="new-workspace-import-session"
      >
        {t("importSession.title")}
      </Button>
    </View>
  );
}

const styles = StyleSheet.create({
  compact: {
    alignItems: "flex-start",
  },
  wide: {
    alignItems: "center",
  },
});

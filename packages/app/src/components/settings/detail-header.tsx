import { ArrowLeft } from "lucide-react-native";
import type { ReactNode } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { Button } from "@/components/ui/button";

/**
 * "Back to …" above a settings detail page on wide layouts, where the page has no header of its
 * own. The ghost button drops its padding so the arrow sits on the content's leading rail.
 */
export function SettingsBackLink({
  label,
  onPress,
  testID,
}: {
  label: string;
  onPress: () => void;
  testID?: string;
}) {
  return (
    <Button
      testID={testID}
      accessibilityLabel={label}
      onPress={onPress}
      variant="ghost"
      leftIcon={ArrowLeft}
      style={styles.backLink}
    >
      {label}
    </Button>
  );
}

/**
 * The top of a settings detail page: "Back to …" when the page has no header of its own, then the
 * icon and name the page is about, with an optional action after the name.
 */
export function SettingsDetailHeader({
  back,
  icon,
  title,
  trailing,
  titleTestID,
}: {
  back?: { label: string; onPress: () => void; testID?: string };
  icon: ReactNode;
  title: string;
  trailing?: ReactNode;
  titleTestID?: string;
}) {
  return (
    <View style={styles.header}>
      {back ? <SettingsBackLink {...back} /> : null}
      <View style={styles.titleRow}>
        {icon}
        <Text style={styles.title} numberOfLines={1} testID={titleTestID}>
          {title}
        </Text>
        {trailing}
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  backLink: {
    alignSelf: "flex-start",
    paddingHorizontal: 0,
  },
  header: {
    gap: theme.spacing[2],
    marginBottom: theme.spacing[4],
  },
  titleRow: {
    marginTop: theme.spacing[2],
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
  },
  title: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
    flexShrink: 1,
  },
}));

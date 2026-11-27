import { ArrowLeft } from "lucide-react-native";
import type { ReactNode } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { PageTitle, type PageTitleParent } from "@/components/page-layout";
import { Button } from "@/components/ui/button";
import { useIsCompactFormFactor } from "@/constants/layout";

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
 * The top of a settings detail page: the icon and name of the thing the page is about, with an
 * optional action after the name. On wide layouts it is the page's title and names the parent page
 * first, which goes back to it. On compact layouts the back header already names the parent.
 */
export function SettingsDetailHeader({
  parent,
  icon,
  title,
  trailing,
  titleTestID,
}: {
  parent: PageTitleParent;
  icon?: ReactNode;
  /** Absent while the page has nothing to name, such as a project that no longer exists. */
  title?: string;
  trailing?: ReactNode;
  titleTestID?: string;
}) {
  const isCompact = useIsCompactFormFactor();
  if (!isCompact)
    return (
      <PageTitle
        parent={parent}
        icon={icon}
        title={title}
        adornment={trailing}
        titleTestID={titleTestID}
      />
    );
  if (title === undefined) return null;
  return (
    <View style={styles.titleRow}>
      {icon}
      <Text style={styles.title} numberOfLines={1} testID={titleTestID}>
        {title}
      </Text>
      {trailing}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  backLink: {
    alignSelf: "flex-start",
    paddingHorizontal: 0,
  },
  titleRow: {
    // Line up with the section titles, which sit inset from their cards.
    marginLeft: theme.spacing[1],
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
    marginBottom: theme.spacing[4],
  },
  title: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
    flexShrink: 1,
  },
}));

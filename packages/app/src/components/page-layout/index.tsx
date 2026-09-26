import { useMemo, type ReactNode } from "react";
import { ScrollView, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { StyleSheet } from "react-native-unistyles";
import { BackHeader } from "@/components/headers/back-header";
import { MenuHeader } from "@/components/headers/menu-header";
import { useIsCompactFormFactor } from "@/constants/layout";

interface PageLayoutProps {
  title?: string;
  /** Compact back button. Defaults to navigating back. */
  onBack?: () => void;
  testID?: string;
  children: ReactNode;
}

/**
 * A full-width page with a centered content column. On desktop the title is a
 * document heading inside the page and the header only keeps the titlebar drag
 * region and window controls; on compact the title moves into a back header.
 */
export function PageLayout({ title, onBack, testID, children }: PageLayoutProps) {
  const isCompact = useIsCompactFormFactor();
  const insets = useSafeAreaInsets();
  const scrollContentStyle = useMemo(() => ({ paddingBottom: insets.bottom }), [insets.bottom]);
  const showTitle = !isCompact && title !== undefined;

  return (
    <View style={styles.container}>
      {isCompact ? <BackHeader title={title} onBack={onBack} /> : <MenuHeader borderless />}
      <ScrollView style={styles.scroll} contentContainerStyle={scrollContentStyle} testID={testID}>
        <View style={styles.content}>
          {showTitle ? (
            <Text style={styles.title} testID="page-title">
              {title}
            </Text>
          ) : null}
          {children}
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    backgroundColor: theme.colors.surface0,
  },
  scroll: {
    flex: 1,
  },
  content: {
    padding: theme.spacing[4],
    paddingTop: theme.spacing[6],
    width: "100%",
    maxWidth: 720,
    alignSelf: "center",
  },
  title: {
    // Line up with the section titles, which sit inset from their cards.
    marginLeft: theme.spacing[1],
    marginBottom: theme.spacing[6],
    fontSize: theme.fontSize["4xl"],
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
  },
}));

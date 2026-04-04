import { useEffect } from "react";
import { View, Text } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { FolderOpen } from "lucide-react-native";
import { PaseoLogo } from "@/components/icons/paseo-logo";
import { Button } from "@/components/ui/button";
import { MenuHeader } from "@/components/headers/menu-header";
import { useOpenProjectPicker } from "@/hooks/use-open-project-picker";
import { usePanelStore } from "@/stores/panel-store";
import { useSessionStore } from "@/stores/session-store";
import { isCompactFormFactor, HEADER_INNER_HEIGHT, HEADER_INNER_HEIGHT_MOBILE, HEADER_TOP_PADDING_MOBILE } from "@/constants/layout";
import { TitlebarDragRegion } from "@/components/desktop/titlebar-drag-region";

export function OpenProjectScreen({ serverId }: { serverId: string }) {
  const openAgentList = usePanelStore((s) => s.openAgentList);
  const openProjectPicker = useOpenProjectPicker(serverId);
  const hasHydrated = useSessionStore((s) => s.sessions[serverId]?.hasHydratedWorkspaces ?? false);
  const hasProjects = useSessionStore((s) => (s.sessions[serverId]?.workspaces?.size ?? 0) > 0);

  const isCompactLayout = isCompactFormFactor();

  useEffect(() => {
    if (!isCompactLayout) {
      openAgentList();
    }
  }, [isCompactLayout, openAgentList]);

  return (
    <View style={styles.container}>
      <MenuHeader borderless />
      <View style={styles.content}>
        <TitlebarDragRegion />
        <View style={styles.logo}>
          <PaseoLogo size={56} />
        </View>
        <View style={styles.headingGroup}>
          <Text style={styles.heading}>What shall we build today?</Text>
          {hasHydrated && !hasProjects ? (
            <Text style={styles.subtitle}>
              Add a project folder to start running agents on your codebase
            </Text>
          ) : null}
        </View>
        <View style={styles.cta}>
          <Button variant="default" leftIcon={FolderOpen} onPress={() => void openProjectPicker()} testID="open-project-submit">
            Add a project
          </Button>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    backgroundColor: theme.colors.surface0,
    userSelect: "none",
  },
  content: {
    position: "relative",
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    gap: 0,
    padding: theme.spacing[6],
    paddingBottom: {
      xs: HEADER_INNER_HEIGHT_MOBILE + HEADER_TOP_PADDING_MOBILE + theme.spacing[6],
      md: HEADER_INNER_HEIGHT + theme.spacing[6],
    },
  },
  logo: {
    marginBottom: theme.spacing[8],
  },
  headingGroup: {
    alignItems: "center",
    gap: theme.spacing[3],
  },
  cta: {
    marginTop: theme.spacing[12],
  },
  heading: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize["2xl"],
    fontWeight: theme.fontWeight.normal,
    textAlign: "center",
  },
  subtitle: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
    textAlign: "center",
  },
}));

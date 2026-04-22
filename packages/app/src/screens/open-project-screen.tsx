import { useEffect, useState } from "react";
import { View, Text } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { FolderOpen, Smartphone } from "lucide-react-native";
import { PaseoLogo } from "@/components/icons/paseo-logo";
import { Button } from "@/components/ui/button";
import { MenuHeader } from "@/components/headers/menu-header";
import { useOpenProjectPicker } from "@/hooks/use-open-project-picker";
import { usePanelStore } from "@/stores/panel-store";
import { useSessionStore } from "@/stores/session-store";
import { useHasWorkspaces } from "@/stores/session-store-hooks";
import {
  useIsCompactFormFactor,
  HEADER_INNER_HEIGHT,
  HEADER_INNER_HEIGHT_MOBILE,
  HEADER_TOP_PADDING_MOBILE,
} from "@/constants/layout";
import { TitlebarDragRegion } from "@/components/desktop/titlebar-drag-region";
import { useIsLocalDaemon } from "@/hooks/use-is-local-daemon";
import { PairDeviceModal } from "@/desktop/components/pair-device-modal";

export function OpenProjectScreen({ serverId }: { serverId: string }) {
  const openDesktopAgentList = usePanelStore((s) => s.openDesktopAgentList);
  const openProjectPicker = useOpenProjectPicker(serverId);
  const hasHydrated = useSessionStore((s) => s.sessions[serverId]?.hasHydratedWorkspaces ?? false);
  const hasProjects = useHasWorkspaces(serverId);
  const isLocalDaemon = useIsLocalDaemon(serverId);
  const [isPairDeviceOpen, setIsPairDeviceOpen] = useState(false);

  const isCompactLayout = useIsCompactFormFactor();

  useEffect(() => {
    if (!isCompactLayout) {
      openDesktopAgentList();
    }
  }, [isCompactLayout, openDesktopAgentList]);

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
          <Button
            variant="default"
            leftIcon={FolderOpen}
            onPress={() => void openProjectPicker()}
            testID="open-project-submit"
          >
            Add a project
          </Button>
          {isLocalDaemon ? (
            <Button
              variant="outline"
              leftIcon={Smartphone}
              onPress={() => setIsPairDeviceOpen(true)}
              testID="open-project-pair-device"
            >
              Pair device
            </Button>
          ) : null}
        </View>
      </View>
      <PairDeviceModal
        visible={isPairDeviceOpen}
        onClose={() => setIsPairDeviceOpen(false)}
        testID="open-project-pair-device-modal"
      />
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
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
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

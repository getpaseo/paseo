import { useState } from "react";
import { View, Text } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import Animated from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { FOOTER_HEIGHT, MAX_CONTENT_WIDTH } from "@/constants/layout";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { useKeyboardShiftStyle } from "@/hooks/use-keyboard-shift-style";
import { Button } from "@/components/ui/button";
import type { Theme } from "@/styles/theme";

interface ArchivedAgentCalloutProps {
  serverId: string;
  agentId: string;
}

export function ArchivedAgentCallout({ serverId, agentId }: ArchivedAgentCalloutProps) {
  const insets = useSafeAreaInsets();
  const client = useHostRuntimeClient(serverId);
  const isConnected = useHostRuntimeIsConnected(serverId);
  const [isUnarchiving, setIsUnarchiving] = useState(false);

  const { style: keyboardAnimatedStyle } = useKeyboardShiftStyle({ mode: "translate" });

  async function handleUnarchive() {
    if (!client || !isConnected || isUnarchiving) return;
    setIsUnarchiving(true);
    try {
      await client.refreshAgent(agentId);
    } catch (error) {
      console.error("[ArchivedAgentCallout] Failed to unarchive agent:", error);
      setIsUnarchiving(false);
    }
  }

  return (
    <Animated.View
      style={[styles.container, { paddingBottom: insets.bottom }, keyboardAnimatedStyle]}
    >
      <View style={styles.inputAreaContainer}>
        <View style={styles.inputAreaContent}>
          <View style={styles.callout}>
            <Text style={styles.calloutText}>This agent is archived</Text>
            <Button
              size="sm"
              variant="secondary"
              onPress={handleUnarchive}
              disabled={!isConnected || isUnarchiving}
            >
              Unarchive
            </Button>
          </View>
        </View>
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create(((theme: Theme) => ({
  container: {
    flexDirection: "column",
    position: "relative",
  },
  inputAreaContainer: {
    position: "relative",
    minHeight: FOOTER_HEIGHT,
    marginHorizontal: "auto",
    alignItems: "center",
    width: "100%",
    overflow: "visible",
    padding: theme.spacing[4],
  },
  inputAreaContent: {
    width: "100%",
    maxWidth: MAX_CONTENT_WIDTH,
  },
  callout: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[3],
    backgroundColor: theme.colors.surface1,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.borderAccent,
    borderRadius: theme.borderRadius["2xl"],
    paddingVertical: {
      xs: theme.spacing[3],
      md: theme.spacing[4],
    },
    paddingHorizontal: {
      xs: theme.spacing[4],
      md: theme.spacing[6],
    },
  },
  calloutText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
  },
})) as any) as Record<string, any>;

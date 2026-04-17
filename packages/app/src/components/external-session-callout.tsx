import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Text, View } from "react-native";
import Animated from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { FOOTER_HEIGHT, MAX_CONTENT_WIDTH } from "@/constants/layout";
import { useKeyboardShiftStyle } from "@/hooks/use-keyboard-shift-style";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import type { Agent } from "@/stores/session-store";
import { describeExternalSessionRecovery } from "@/utils/external-session";
import { Button } from "@/components/ui/button";
import type { Theme } from "@/styles/theme";
import { StyleSheet } from "react-native-unistyles";

interface ExternalSessionCalloutProps {
  serverId: string;
  agent: Agent;
  autoRecover?: boolean;
  onRecovered?: () => Promise<void> | void;
  onRecoveryError?: (error: unknown) => void;
}

export function ExternalSessionCallout({
  serverId,
  agent,
  autoRecover = false,
  onRecovered,
  onRecoveryError,
}: ExternalSessionCalloutProps) {
  const insets = useSafeAreaInsets();
  const client = useHostRuntimeClient(serverId);
  const isConnected = useHostRuntimeIsConnected(serverId);
  const [isRecovering, setIsRecovering] = useState(false);
  const [recoveryError, setRecoveryError] = useState<string | null>(null);
  const autoRecoveryStartedRef = useRef(false);
  const descriptor = useMemo(() => describeExternalSessionRecovery(agent), [agent]);
  const { style: keyboardAnimatedStyle } = useKeyboardShiftStyle({ mode: "translate" });

  const handleRecover = useCallback(async () => {
    if (!descriptor.canRecoverWhenClosed || !client || !isConnected || isRecovering) {
      return;
    }

    setIsRecovering(true);
    setRecoveryError(null);
    try {
      await client.refreshAgent(agent.id);
      await onRecovered?.();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setRecoveryError(message);
      onRecoveryError?.(error);
    } finally {
      setIsRecovering(false);
    }
  }, [
    agent.id,
    client,
    descriptor.canRecoverWhenClosed,
    isConnected,
    isRecovering,
    onRecovered,
    onRecoveryError,
  ]);

  useEffect(() => {
    if (!autoRecover || autoRecoveryStartedRef.current || !descriptor.canRecoverWhenClosed) {
      return;
    }
    if (!isConnected) {
      return;
    }
    autoRecoveryStartedRef.current = true;
    void handleRecover();
  }, [autoRecover, descriptor.canRecoverWhenClosed, handleRecover, isConnected]);

  if (!descriptor.canRecoverWhenClosed) {
    return null;
  }

  return (
    <Animated.View
      style={[styles.container, { paddingBottom: insets.bottom }, keyboardAnimatedStyle]}
    >
      <View style={styles.inputAreaContainer}>
        <View style={styles.inputAreaContent}>
          <View style={styles.callout}>
            <View style={styles.copyBlock}>
              <Text style={styles.calloutTitle}>Closed external session</Text>
              <Text style={styles.calloutText}>
                {isRecovering
                  ? "Restarting terminal and reattaching session..."
                  : descriptor.summary}
              </Text>
              {recoveryError ? <Text style={styles.errorText}>{recoveryError}</Text> : null}
            </View>
            <Button
              size="sm"
              variant="secondary"
              onPress={() => {
                void handleRecover();
              }}
              disabled={!isConnected || isRecovering}
            >
              {isRecovering ? "Recovering..." : descriptor.restartLabel}
            </Button>
          </View>
          {isRecovering ? (
            <View style={styles.progressRow}>
              <ActivityIndicator size="small" />
            </View>
          ) : null}
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
    gap: theme.spacing[2],
  },
  callout: {
    flexDirection: {
      xs: "column",
      md: "row",
    },
    alignItems: {
      xs: "stretch",
      md: "center",
    },
    justifyContent: "space-between",
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
  copyBlock: {
    flex: 1,
    gap: theme.spacing[1],
  },
  calloutTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.semibold,
  },
  calloutText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  errorText: {
    color: theme.colors.palette.red[300],
    fontSize: theme.fontSize.xs,
  },
  progressRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
  },
})) as any) as Record<string, any>;

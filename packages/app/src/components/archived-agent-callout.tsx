import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { View, Text } from "react-native";
import { useTranslation } from "react-i18next";
import { ArchiveRestore } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { CHAT_COLUMN_RAIL_DATASET } from "@/chat-rail";
import { FOOTER_HEIGHT } from "@/constants/layout";
import { useToast } from "@/contexts/toast-context";
import { useUnarchiveAgent } from "@/hooks/use-unarchive-agent";
import { KeyboardTranslateView } from "@/keyboard/shift";
import { Button } from "@/components/ui/button";
import { CONTROL_HEIGHTS } from "@/components/ui/control-geometry";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import type { Theme } from "@/styles/theme";
import { toErrorMessage } from "@/utils/error-messages";

const ThemedLoadingSpinner = withUnistyles(LoadingSpinner);
const foregroundMutedColorMapping = (theme: Theme) => ({
  color: theme.colors.foregroundMuted,
});

interface ArchivedAgentCalloutProps {
  serverId: string;
  agentId: string;
  /** True while the owning workspace's archive undo is restoring this agent. */
  isWorkspaceRestoring?: boolean;
}

export function deliverUnarchiveError(input: {
  error: unknown;
  attemptKey: string;
  isMounted: boolean;
  currentTargetKey: string;
  onInlineError: (state: { targetKey: string; message: string }) => void;
  onToastError: (message: string) => void;
}): void {
  const message = toErrorMessage(input.error);
  if (input.isMounted && input.currentTargetKey === input.attemptKey) {
    input.onInlineError({ targetKey: input.attemptKey, message });
  } else {
    input.onToastError(message);
  }
}

function ArchivedCalloutRow({
  isShowingUnarchiving,
  canUnarchive,
  onUnarchive,
}: {
  isShowingUnarchiving: boolean;
  canUnarchive: boolean;
  onUnarchive: () => void;
}) {
  const { t } = useTranslation();
  return (
    <View style={styles.calloutRow}>
      {isShowingUnarchiving ? (
        <>
          <ThemedLoadingSpinner size={14} uniProps={foregroundMutedColorMapping} />
          <Text style={styles.calloutText}>{t("agentPanel.archived.unarchiving")}</Text>
        </>
      ) : (
        <>
          <Text style={styles.calloutText}>{t("agentPanel.archived.callout")}</Text>
          <Button
            variant="secondary"
            leftIcon={ArchiveRestore}
            onPress={onUnarchive}
            disabled={!canUnarchive}
          >
            {t("agentPanel.archived.unarchive")}
          </Button>
        </>
      )}
    </View>
  );
}

export function ArchivedAgentCallout({
  serverId,
  agentId,
  isWorkspaceRestoring = false,
}: ArchivedAgentCalloutProps) {
  const targetKey = `${serverId}:${agentId}`;
  const toast = useToast();
  const { unarchive, isUnarchiving, canUnarchive } = useUnarchiveAgent({ serverId, agentId });
  const isShowingUnarchiving = isWorkspaceRestoring || isUnarchiving;
  const [unarchiveErrorState, setUnarchiveErrorState] = useState<{
    targetKey: string;
    message: string;
  } | null>(null);
  const unarchiveError =
    unarchiveErrorState?.targetKey === targetKey ? unarchiveErrorState.message : null;
  const isMountedRef = useRef(true);
  const targetKeyRef = useRef(targetKey);

  useLayoutEffect(() => {
    targetKeyRef.current = targetKey;
  }, [targetKey]);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const handleUnarchive = useCallback(async () => {
    if (!canUnarchive) return;
    const attemptKey = targetKey;
    setUnarchiveErrorState(null);
    try {
      await unarchive();
    } catch (error) {
      deliverUnarchiveError({
        error,
        attemptKey,
        isMounted: isMountedRef.current,
        currentTargetKey: targetKeyRef.current,
        onInlineError: setUnarchiveErrorState,
        onToastError: toast.error,
      });
    }
  }, [canUnarchive, targetKey, toast, unarchive]);

  return (
    <KeyboardTranslateView style={styles.container}>
      <View style={styles.inputAreaContainer} dataSet={CHAT_COLUMN_RAIL_DATASET}>
        <View style={styles.inputAreaContent}>
          <View style={styles.calloutStack}>
            <View
              style={styles.callout}
              testID={isShowingUnarchiving ? "agent-unarchiving-callout" : "agent-archived-callout"}
            >
              <ArchivedCalloutRow
                isShowingUnarchiving={isShowingUnarchiving}
                canUnarchive={canUnarchive}
                onUnarchive={handleUnarchive}
              />
            </View>
            {!isShowingUnarchiving && unarchiveError ? (
              <Text style={styles.errorText} testID="agent-unarchive-error">
                {unarchiveError}
              </Text>
            ) : null}
          </View>
        </View>
      </View>
    </KeyboardTranslateView>
  );
}

const styles = StyleSheet.create((theme: Theme) => ({
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
    maxWidth: theme.contentMaxWidth,
  },
  callout: {
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
  calloutRow: {
    minHeight: CONTROL_HEIGHTS.md,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[3],
  },
  calloutStack: {
    gap: theme.spacing[2],
  },
  calloutText: {
    flexShrink: 1,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
  },
  errorText: {
    color: theme.colors.statusDanger,
    fontSize: theme.fontSize.base,
    textAlign: "center",
  },
})) as unknown as Record<string, object>;

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ActivityIndicator,
  type LayoutChangeEvent,
  Pressable,
  ScrollView,
  Text,
  View,
} from "react-native";
import { Plus, RefreshCw } from "lucide-react-native";
import { NativeViewGestureHandler } from "react-native-gesture-handler";
import { StyleSheet, UnistylesRuntime, useUnistyles } from "react-native-unistyles";
import { useSessionStore } from "@/stores/session-store";
import { useExplorerSidebarAnimation } from "@/contexts/explorer-sidebar-animation-context";
import TerminalEmulator from "./terminal-emulator";

interface TerminalPaneProps {
  serverId: string;
  cwd: string;
}

const MAX_OUTPUT_CHARS = 200_000;

const MODIFIER_LABELS = {
  ctrl: "Ctrl",
  shift: "Shift",
  alt: "Alt",
} as const;

const KEY_BUTTONS: Array<{ id: string; label: string; key: string }> = [
  { id: "esc", label: "Esc", key: "Escape" },
  { id: "tab", label: "Tab", key: "Tab" },
  { id: "up", label: "↑", key: "ArrowUp" },
  { id: "down", label: "↓", key: "ArrowDown" },
  { id: "left", label: "←", key: "ArrowLeft" },
  { id: "right", label: "→", key: "ArrowRight" },
  { id: "enter", label: "Enter", key: "Enter" },
  { id: "backspace", label: "⌫", key: "Backspace" },
  { id: "c", label: "C", key: "c" },
];

type ModifierState = {
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
};

function terminalScopeKey(serverId: string, cwd: string): string {
  return `${serverId}:${cwd}`;
}

function isTerminalDebugEnabled(): boolean {
  const explicit = (
    globalThis as {
      __PASEO_TERMINAL_DEBUG?: unknown;
    }
  ).__PASEO_TERMINAL_DEBUG;
  if (typeof explicit === "boolean") {
    return explicit;
  }
  const devFlag = (globalThis as { __DEV__?: unknown }).__DEV__;
  return devFlag === true;
}

function logTerminalDebug(message: string, payload?: Record<string, unknown>): void {
  if (!isTerminalDebugEnabled()) {
    return;
  }
  if (payload) {
    console.log("[TerminalDebug][Pane] " + message, payload);
    return;
  }
  console.log("[TerminalDebug][Pane] " + message);
}

export function TerminalPane({ serverId, cwd }: TerminalPaneProps) {
  const { theme } = useUnistyles();
  const isMobile =
    UnistylesRuntime.breakpoint === "xs" || UnistylesRuntime.breakpoint === "sm";

  // Optional when rendered inside the mobile explorer sidebar gesture context.
  let closeGestureRef: React.MutableRefObject<any> | undefined;
  try {
    const animation = useExplorerSidebarAnimation();
    closeGestureRef = animation.closeGestureRef;
  } catch {
    // Terminal pane can render outside explorer sidebar during isolated tests.
  }

  const queryClient = useQueryClient();
  const client = useSessionStore((state) => state.sessions[serverId]?.client ?? null);
  const isConnected = useSessionStore(
    (state) => state.sessions[serverId]?.connection.isConnected ?? false
  );

  const scopeKey = useMemo(() => terminalScopeKey(serverId, cwd), [serverId, cwd]);
  const selectedTerminalByScopeRef = useRef<Map<string, string>>(new Map());
  const lastReportedSizeRef = useRef<{ rows: number; cols: number } | null>(null);

  const [selectedTerminalId, setSelectedTerminalId] = useState<string | null>(null);
  const [outputByTerminalId, setOutputByTerminalId] = useState<Map<string, string>>(
    () => new Map()
  );
  const [activeStream, setActiveStream] = useState<{
    terminalId: string;
    streamId: number;
  } | null>(null);
  const [isAttaching, setIsAttaching] = useState(false);
  const [streamError, setStreamError] = useState<string | null>(null);
  const [modifiers, setModifiers] = useState<ModifierState>({
    ctrl: false,
    shift: false,
    alt: false,
  });

  const terminalsQuery = useQuery({
    queryKey: ["terminals", serverId, cwd] as const,
    enabled: Boolean(client && isConnected && cwd.startsWith("/")),
    queryFn: async () => {
      if (!client) {
        throw new Error("Host is not connected");
      }
      return await client.listTerminals(cwd);
    },
    staleTime: 5_000,
  });

  const terminals = terminalsQuery.data?.terminals ?? [];

  const createTerminalMutation = useMutation({
    mutationFn: async () => {
      if (!client) {
        throw new Error("Host is not connected");
      }
      return await client.createTerminal(cwd);
    },
    onSuccess: (payload) => {
      if (payload.terminal) {
        selectedTerminalByScopeRef.current.set(scopeKey, payload.terminal.id);
        setSelectedTerminalId(payload.terminal.id);
      }
      void queryClient.invalidateQueries({
        queryKey: ["terminals", serverId, cwd],
      });
    },
  });

  useEffect(() => {
    setSelectedTerminalId(selectedTerminalByScopeRef.current.get(scopeKey) ?? null);
    lastReportedSizeRef.current = null;
  }, [scopeKey]);

  useEffect(() => {
    if (selectedTerminalId) {
      selectedTerminalByScopeRef.current.set(scopeKey, selectedTerminalId);
    }
  }, [scopeKey, selectedTerminalId]);

  useEffect(() => {
    if (terminals.length === 0) {
      setSelectedTerminalId(null);
      return;
    }

    const has = (id: string | null | undefined) =>
      Boolean(id && terminals.some((terminal) => terminal.id === id));

    if (has(selectedTerminalId)) {
      return;
    }

    const stored = selectedTerminalByScopeRef.current.get(scopeKey);
    if (has(stored)) {
      setSelectedTerminalId(stored!);
      return;
    }

    const fallback = terminals[0]?.id ?? null;
    if (fallback) {
      selectedTerminalByScopeRef.current.set(scopeKey, fallback);
      setSelectedTerminalId(fallback);
    }
  }, [scopeKey, terminals, selectedTerminalId]);

  const appendOutput = useCallback((terminalId: string, text: string) => {
    if (!text) {
      return;
    }
    setOutputByTerminalId((previous) => {
      const next = new Map(previous);
      const existing = next.get(terminalId) ?? "";
      const combined = `${existing}${text}`;
      next.set(
        terminalId,
        combined.length > MAX_OUTPUT_CHARS
          ? combined.slice(combined.length - MAX_OUTPUT_CHARS)
          : combined
      );
      return next;
    });
  }, []);

  useEffect(() => {
    let isCancelled = false;
    let streamId: number | null = null;
    let unsubscribe: (() => void) | null = null;
    let decoder: TextDecoder | null = null;
    const terminalId = selectedTerminalId;

    if (!client || !isConnected || !terminalId) {
      setActiveStream(null);
      setIsAttaching(false);
      return;
    }

    setIsAttaching(true);
    setStreamError(null);
    lastReportedSizeRef.current = null;

    const attach = async () => {
      try {
        const attachPayload = await client.attachTerminalStream(terminalId);
        if (isCancelled) {
          if (typeof attachPayload.streamId === "number") {
            void client.detachTerminalStream(attachPayload.streamId).catch(() => {});
          }
          return;
        }

        if (attachPayload.error || typeof attachPayload.streamId !== "number") {
          setStreamError(attachPayload.error ?? "Unable to attach terminal stream");
          setActiveStream(null);
          return;
        }

        streamId = attachPayload.streamId;
        decoder = new TextDecoder();
        setActiveStream({ terminalId, streamId });

        unsubscribe = client.onTerminalStreamData(streamId, (chunk) => {
          if (isCancelled) {
            return;
          }
          const text = decoder?.decode(chunk.data, { stream: true }) ?? "";
          appendOutput(terminalId, text);
        });
      } catch (error) {
        if (!isCancelled) {
          setStreamError(
            error instanceof Error ? error.message : "Unable to attach terminal stream"
          );
          setActiveStream(null);
        }
      } finally {
        if (!isCancelled) {
          setIsAttaching(false);
        }
      }
    };

    void attach();

    return () => {
      isCancelled = true;
      if (decoder) {
        appendOutput(terminalId, decoder.decode());
        decoder = null;
      }
      if (unsubscribe) {
        unsubscribe();
        unsubscribe = null;
      }
      if (streamId !== null) {
        void client.detachTerminalStream(streamId).catch(() => {});
      }
    };
  }, [appendOutput, client, isConnected, selectedTerminalId]);

  const activeStreamId =
    activeStream && activeStream.terminalId === selectedTerminalId
      ? activeStream.streamId
      : null;

  const selectedTerminal = useMemo(
    () => terminals.find((terminal) => terminal.id === selectedTerminalId) ?? null,
    [terminals, selectedTerminalId]
  );

  const waitForCloseGesture = Boolean(isMobile && closeGestureRef?.current);

  useEffect(() => {
    logTerminalDebug("render state", {
      scopeKey,
      isMobile,
      terminals: terminals.length,
      selectedTerminalId,
      activeStreamId,
      isAttaching,
      waitForCloseGesture,
    });
  }, [
    activeStreamId,
    isAttaching,
    isMobile,
    scopeKey,
    selectedTerminalId,
    terminals.length,
    waitForCloseGesture,
  ]);

  const handleOutputLayout = useCallback(
    (event: LayoutChangeEvent) => {
      const { width, height } = event.nativeEvent.layout;
      logTerminalDebug("output layout", {
        width: Math.round(width),
        height: Math.round(height),
        selectedTerminalId,
      });
    },
    [selectedTerminalId]
  );

  const handleTerminalLayout = useCallback((event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    logTerminalDebug("terminal container layout", {
      width: Math.round(width),
      height: Math.round(height),
    });
  }, []);

  const currentOutput = selectedTerminalId
    ? (outputByTerminalId.get(selectedTerminalId) ?? "")
    : "";

  const handleRefresh = useCallback(() => {
    void terminalsQuery.refetch();
  }, [terminalsQuery]);

  const handleCreateTerminal = useCallback(() => {
    createTerminalMutation.mutate();
  }, [createTerminalMutation]);

  const handleTerminalData = useCallback(
    async (data: string) => {
      if (!client || activeStreamId === null || data.length === 0) {
        return;
      }
      logTerminalDebug("send input", {
        length: data.length,
        preview: data.slice(0, 24),
      });
      client.sendTerminalStreamInput(activeStreamId, data);
    },
    [client, activeStreamId]
  );

  const handleTerminalResize = useCallback(
    async (rows: number, cols: number) => {
      if (!client || !selectedTerminalId || rows <= 0 || cols <= 0) {
        return;
      }
      const normalizedRows = Math.floor(rows);
      const normalizedCols = Math.floor(cols);
      const previous = lastReportedSizeRef.current;
      if (
        previous &&
        previous.rows === normalizedRows &&
        previous.cols === normalizedCols
      ) {
        return;
      }
      logTerminalDebug("send resize", {
        rows: normalizedRows,
        cols: normalizedCols,
        selectedTerminalId,
      });
      lastReportedSizeRef.current = { rows: normalizedRows, cols: normalizedCols };
      client.sendTerminalInput(selectedTerminalId, {
        type: "resize",
        rows: normalizedRows,
        cols: normalizedCols,
      });
    },
    [client, selectedTerminalId]
  );

  const toggleModifier = useCallback((modifier: keyof ModifierState) => {
    setModifiers((current) => ({ ...current, [modifier]: !current[modifier] }));
  }, []);

  const sendVirtualKey = useCallback(
    (key: string) => {
      if (!client || activeStreamId === null) {
        return;
      }
      client.sendTerminalStreamKey(activeStreamId, {
        key: key.length === 1 ? key.toLowerCase() : key,
        ctrl: modifiers.ctrl,
        shift: modifiers.shift,
        alt: modifiers.alt,
      });
      logTerminalDebug("send virtual key", {
        key,
        ctrl: modifiers.ctrl,
        shift: modifiers.shift,
        alt: modifiers.alt,
      });
      setModifiers({ ctrl: false, shift: false, alt: false });
    },
    [client, activeStreamId, modifiers.alt, modifiers.ctrl, modifiers.shift]
  );

  if (!client || !isConnected) {
    return (
      <View style={styles.centerState}>
        <Text style={styles.stateText}>Host is not connected</Text>
      </View>
    );
  }

  const queryError =
    terminalsQuery.error instanceof Error ? terminalsQuery.error.message : null;
  const isCreating = createTerminalMutation.isPending;
  const isRefreshing = terminalsQuery.isFetching;
  const createError =
    createTerminalMutation.error instanceof Error
      ? createTerminalMutation.error.message
      : null;
  const combinedError = streamError ?? createError ?? queryError;

  return (
    <View style={styles.container}>
      <View style={styles.header} testID="terminals-header">
        <ScrollView
          horizontal
          style={styles.tabsScroll}
          contentContainerStyle={styles.tabsContent}
          showsHorizontalScrollIndicator={false}
        >
          {terminals.map((terminal) => {
            const isActive = terminal.id === selectedTerminalId;
            return (
              <Pressable
                key={terminal.id}
                testID={`terminal-tab-${terminal.id}`}
                onPress={() => setSelectedTerminalId(terminal.id)}
                style={({ pressed, hovered }) => [
                  styles.terminalTab,
                  isActive && styles.terminalTabActive,
                  (pressed || hovered) && styles.terminalTabHovered,
                ]}
              >
                <Text style={[styles.terminalTabText, isActive && styles.terminalTabTextActive]}>
                  {terminal.name}
                </Text>
              </Pressable>
            );
          })}
        </ScrollView>
        <View style={styles.headerActions}>
          <Pressable
            testID="terminals-refresh-button"
            onPress={handleRefresh}
            disabled={isRefreshing}
            style={({ hovered, pressed }) => [
              styles.headerIconButton,
              (hovered || pressed) && styles.headerIconButtonHovered,
            ]}
          >
            {isRefreshing ? (
              <ActivityIndicator size="small" color={theme.colors.foregroundMuted} />
            ) : (
              <RefreshCw size={16} color={theme.colors.foregroundMuted} />
            )}
          </Pressable>
          <Pressable
            testID="terminals-create-button"
            onPress={handleCreateTerminal}
            disabled={isCreating}
            style={({ hovered, pressed }) => [
              styles.headerIconButton,
              (hovered || pressed) && styles.headerIconButtonHovered,
            ]}
          >
            {isCreating ? (
              <ActivityIndicator size="small" color={theme.colors.foregroundMuted} />
            ) : (
              <Plus size={16} color={theme.colors.foregroundMuted} />
            )}
          </Pressable>
        </View>
      </View>

      <View style={styles.outputContainer} onLayout={handleOutputLayout}>
        {selectedTerminal ? (
          <NativeViewGestureHandler
            disallowInterruption={false}
            waitFor={waitForCloseGesture ? closeGestureRef : undefined}
          >
            <View style={styles.terminalGestureContainer} onLayout={handleTerminalLayout}>
              <TerminalEmulator
                dom={{
                  style: { flex: 1 },
                  matchContents: false,
                  scrollEnabled: true,
                  nestedScrollEnabled: true,
                  overScrollMode: "never",
                }}
                streamKey={`${scopeKey}:${selectedTerminal.id}:${activeStreamId ?? "none"}`}
                outputText={currentOutput}
                testId="terminal-surface"
                backgroundColor={theme.colors.background}
                foregroundColor={theme.colors.foreground}
                cursorColor={theme.colors.foreground}
                onInput={handleTerminalData}
                onResize={handleTerminalResize}
              />
            </View>
          </NativeViewGestureHandler>
        ) : (
          <View style={styles.centerState}>
            <Text style={styles.stateText}>No terminal selected</Text>
          </View>
        )}

        {isAttaching ? (
          <View style={styles.attachOverlay}>
            <ActivityIndicator size="small" color={theme.colors.foregroundMuted} />
            <Text style={styles.attachOverlayText}>Attaching terminal…</Text>
          </View>
        ) : null}
      </View>

      {combinedError ? (
        <View style={styles.errorRow}>
          <Text style={styles.statusError} numberOfLines={2}>
            {combinedError}
          </Text>
        </View>
      ) : null}

      {isMobile ? (
        <View style={styles.keyboardContainer} testID="terminal-virtual-keyboard">
          <ScrollView horizontal showsHorizontalScrollIndicator={false}>
            <View style={styles.keyboardRow}>
              {(Object.keys(MODIFIER_LABELS) as Array<keyof ModifierState>).map((modifier) => (
                <Pressable
                  key={modifier}
                  testID={`terminal-key-${modifier}`}
                  onPress={() => toggleModifier(modifier)}
                  style={({ hovered, pressed }) => [
                    styles.keyButton,
                    modifiers[modifier] && styles.keyButtonActive,
                    (hovered || pressed) && styles.keyButtonHovered,
                  ]}
                >
                  <Text style={[styles.keyButtonText, modifiers[modifier] && styles.keyButtonTextActive]}>
                    {MODIFIER_LABELS[modifier]}
                  </Text>
                </Pressable>
              ))}

              {KEY_BUTTONS.map((button) => (
                <Pressable
                  key={button.id}
                  testID={`terminal-key-${button.id}`}
                  onPress={() => sendVirtualKey(button.key)}
                  style={({ hovered, pressed }) => [
                    styles.keyButton,
                    (hovered || pressed) && styles.keyButtonHovered,
                  ]}
                >
                  <Text style={styles.keyButtonText}>{button.label}</Text>
                </Pressable>
              ))}
            </View>
          </ScrollView>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    minHeight: 0,
    backgroundColor: theme.colors.surface0,
  },
  header: {
    minHeight: 48,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[2],
  },
  tabsScroll: {
    flex: 1,
    minWidth: 0,
  },
  tabsContent: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    paddingRight: theme.spacing[2],
  },
  terminalTab: {
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.md,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    backgroundColor: theme.colors.surface1,
  },
  terminalTabHovered: {
    backgroundColor: theme.colors.surface2,
  },
  terminalTabActive: {
    borderColor: theme.colors.primary,
    backgroundColor: theme.colors.surface2,
  },
  terminalTabText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  terminalTabTextActive: {
    color: theme.colors.foreground,
    fontWeight: theme.fontWeight.medium,
  },
  headerActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  headerIconButton: {
    width: 30,
    height: 30,
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
    alignItems: "center",
    justifyContent: "center",
  },
  headerIconButtonHovered: {
    backgroundColor: theme.colors.surface2,
  },
  outputContainer: {
    flex: 1,
    minHeight: 0,
    position: "relative",
    backgroundColor: theme.colors.background,
  },
  terminalGestureContainer: {
    flex: 1,
    minHeight: 0,
  },
  attachOverlay: {
    position: "absolute",
    top: theme.spacing[3],
    right: theme.spacing[3],
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface0,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
  },
  attachOverlayText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  errorRow: {
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[1],
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
  },
  statusError: {
    color: theme.colors.destructive,
    fontSize: theme.fontSize.xs,
  },
  keyboardContainer: {
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
    backgroundColor: theme.colors.surface0,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[2],
  },
  keyboardRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    paddingRight: theme.spacing[3],
  },
  keyButton: {
    minWidth: 44,
    height: 34,
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: theme.spacing[2],
    backgroundColor: theme.colors.surface1,
  },
  keyButtonHovered: {
    backgroundColor: theme.colors.surface2,
  },
  keyButtonActive: {
    borderColor: theme.colors.primary,
    backgroundColor: theme.colors.surface2,
  },
  keyButtonText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  keyButtonTextActive: {
    color: theme.colors.foreground,
  },
  centerState: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: theme.spacing[4],
  },
  stateText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    textAlign: "center",
  },
}));

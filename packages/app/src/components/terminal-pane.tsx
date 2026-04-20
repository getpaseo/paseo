import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useFocusEffect, useIsFocused } from "@react-navigation/native";
import { ActivityIndicator, Pressable, ScrollView, Text, View } from "react-native";
import Animated, { runOnJS, useAnimatedReaction } from "react-native-reanimated";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { encodeTerminalKeyInput } from "@server/shared/terminal-key-input";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { useKeyboardShiftStyle } from "@/hooks/use-keyboard-shift-style";
import { useAppVisible } from "@/hooks/use-app-visible";
import { useStableEvent } from "@/hooks/use-stable-event";
import {
  hasPendingTerminalModifiers,
  normalizeTerminalTransportKey,
  resolvePendingModifierDataInput,
} from "@/utils/terminal-keys";
import { getWorkspaceTerminalSession } from "@/terminal/runtime/workspace-terminal-session";
import {
  TerminalStreamController,
  type TerminalStreamControllerStatus,
} from "@/terminal/runtime/terminal-stream-controller";
import { usePanelStore } from "@/stores/panel-store";
import { toXtermTheme } from "@/utils/to-xterm-theme";
import TerminalEmulator, { type TerminalEmulatorHandle } from "./terminal-emulator";
import { useIsCompactFormFactor } from "@/constants/layout";

interface TerminalPaneProps {
  serverId: string;
  cwd: string;
  terminalId: string;
  isPaneFocused: boolean;
}

const TERMINAL_REFIT_DELAYS_MS = [0, 48, 144, 320];

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

type PendingTerminalInput =
  | {
      type: "data";
      data: string;
    }
  | {
      type: "key";
      input: {
        key: string;
        ctrl: boolean;
        shift: boolean;
        alt: boolean;
        meta?: boolean;
      };
    };

const EMPTY_MODIFIERS: ModifierState = {
  ctrl: false,
  shift: false,
  alt: false,
};

function terminalScopeKey(input: { serverId: string; cwd: string }): string {
  return `${input.serverId}:${input.cwd}`;
}

export function TerminalPane({ serverId, cwd, terminalId, isPaneFocused }: TerminalPaneProps) {
  const isScreenFocused = useIsFocused();
  const isAppVisible = useAppVisible();
  const { theme } = useUnistyles();
  const xtermTheme = useMemo(() => toXtermTheme(theme.colors.terminal), [theme]);
  const isMobile = useIsCompactFormFactor();
  const mobileView = usePanelStore((state) => state.mobileView);
  const openAgentList = usePanelStore((state) => state.openAgentList);
  const openFileExplorer = usePanelStore((state) => state.openFileExplorer);
  const swipeGesturesEnabled = isMobile && mobileView === "agent";
  const { shift: keyboardShift, style: keyboardPaddingStyle } = useKeyboardShiftStyle({
    mode: "padding",
    enabled: isMobile,
  });

  const client = useHostRuntimeClient(serverId);
  const isConnected = useHostRuntimeIsConnected(serverId);

  const scopeKey = useMemo(() => terminalScopeKey({ serverId, cwd }), [serverId, cwd]);
  const lastReportedSizeRef = useRef<{ rows: number; cols: number } | null>(null);
  const streamControllerRef = useRef<TerminalStreamController | null>(null);
  const workspaceTerminalSession = useMemo(
    () => getWorkspaceTerminalSession({ scopeKey }),
    [scopeKey],
  );
  const [isAttaching, setIsAttaching] = useState(false);
  const [streamError, setStreamError] = useState<string | null>(null);
  const [modifiers, setModifiers] = useState<ModifierState>(EMPTY_MODIFIERS);
  const [focusRequestToken, setFocusRequestToken] = useState(0);
  const [resizeRequestToken, setResizeRequestToken] = useState(0);
  const emulatorRef = useRef<TerminalEmulatorHandle>(null);
  const terminalIdRef = useRef<string>(terminalId);
  const pendingTerminalInputRef = useRef<PendingTerminalInput[]>([]);
  const keyboardRefitTimeoutsRef = useRef<Array<ReturnType<typeof setTimeout>>>([]);
  const lastAutoFocusKeyRef = useRef<string | null>(null);
  const initialSnapshot = workspaceTerminalSession.snapshots.get({ terminalId });

  useEffect(() => {
    terminalIdRef.current = terminalId;
  }, [terminalId]);

  const requestTerminalFocus = useCallback(() => {
    setFocusRequestToken((current) => current + 1);
  }, []);
  const requestTerminalReflow = useCallback(() => {
    setResizeRequestToken((current) => current + 1);
  }, []);

  useEffect(() => {
    if (isMobile || !isScreenFocused || !isPaneFocused || !terminalId) {
      lastAutoFocusKeyRef.current = null;
      return;
    }

    const nextFocusKey = `${scopeKey}:${terminalId}`;
    if (lastAutoFocusKeyRef.current === nextFocusKey) {
      return;
    }

    lastAutoFocusKeyRef.current = nextFocusKey;
    requestTerminalFocus();
  }, [isMobile, isPaneFocused, isScreenFocused, requestTerminalFocus, scopeKey, terminalId]);

  useEffect(() => {
    if (isPaneFocused && isScreenFocused && isAppVisible && terminalId) {
      lastReportedSizeRef.current = null;
      requestTerminalReflow();
    }
  }, [isAppVisible, isPaneFocused, isScreenFocused, requestTerminalReflow, terminalId]);

  const clearKeyboardRefitTimeouts = useCallback(() => {
    if (keyboardRefitTimeoutsRef.current.length === 0) {
      return;
    }
    for (const handle of keyboardRefitTimeoutsRef.current) {
      clearTimeout(handle);
    }
    keyboardRefitTimeoutsRef.current = [];
  }, []);

  const pulseKeyboardRefits = useCallback(() => {
    clearKeyboardRefitTimeouts();
    requestTerminalReflow();
    keyboardRefitTimeoutsRef.current = TERMINAL_REFIT_DELAYS_MS.map((delayMs) =>
      setTimeout(() => {
        requestTerminalReflow();
      }, delayMs),
    );
  }, [clearKeyboardRefitTimeouts, requestTerminalReflow]);

  useEffect(() => {
    return () => clearKeyboardRefitTimeouts();
  }, [clearKeyboardRefitTimeouts]);

  useAnimatedReaction(
    () => keyboardShift.value > 0,
    (next, prev) => {
      if (next === prev) {
        return;
      }
      runOnJS(pulseKeyboardRefits)();
    },
    [pulseKeyboardRefits],
  );

  useFocusEffect(
    useCallback(() => {
      if (!terminalId) {
        return;
      }
      // Navigation transitions can temporarily report stale dimensions.
      // Pulse forced refits so xterm fills the pane when returning to an agent.
      const timeoutHandles = TERMINAL_REFIT_DELAYS_MS.map((delayMs) =>
        setTimeout(() => {
          requestTerminalReflow();
        }, delayMs),
      );

      return () => {
        for (const handle of timeoutHandles) {
          clearTimeout(handle);
        }
      };
    }, [requestTerminalReflow, terminalId]),
  );

  useEffect(() => {
    if (!client || !isConnected || !isScreenFocused) {
      return;
    }

    return client.on("terminal_stream_exit", (message) => {
      if (message.type !== "terminal_stream_exit") {
        return;
      }

      const exitedTerminalId = message.payload.terminalId;
      if (!exitedTerminalId) {
        return;
      }

      workspaceTerminalSession.snapshots.clear({ terminalId: exitedTerminalId });
      if (terminalIdRef.current === exitedTerminalId) {
        emulatorRef.current?.clear();
      }
      streamControllerRef.current?.handleTerminalExit({
        terminalId: exitedTerminalId,
      });
      setModifiers({ ...EMPTY_MODIFIERS });
    });
  }, [client, isConnected, workspaceTerminalSession.snapshots]);

  useEffect(() => {
    lastReportedSizeRef.current = null;
  }, [scopeKey]);

  const handleStreamControllerStatus = useCallback((status: TerminalStreamControllerStatus) => {
    setIsAttaching(status.isAttaching);
    setStreamError(status.error);
  }, []);

  useEffect(() => {
    streamControllerRef.current?.dispose();
    streamControllerRef.current = null;
    setIsAttaching(false);
    setStreamError(null);

    if (!client || !isConnected) {
      return;
    }

    const controller = new TerminalStreamController({
      client,
      getPreferredSize: () => lastReportedSizeRef.current,
      onOutput: ({ terminalId, text }) => {
        if (!isScreenFocused || terminalIdRef.current !== terminalId) {
          return;
        }
        emulatorRef.current?.writeOutput(text);
      },
      onSnapshot: ({ terminalId, state }) => {
        workspaceTerminalSession.snapshots.set({ terminalId, state });
        if (!isScreenFocused || terminalIdRef.current !== terminalId) {
          return;
        }
        emulatorRef.current?.renderSnapshot(state);
      },
      onStatusChange: handleStreamControllerStatus,
    });

    streamControllerRef.current = controller;
    controller.setTerminal({
      terminalId: isScreenFocused ? terminalIdRef.current : null,
    });

    return () => {
      controller.dispose();
      if (streamControllerRef.current === controller) {
        streamControllerRef.current = null;
      }
    };
  }, [
    client,
    handleStreamControllerStatus,
    isConnected,
    isScreenFocused,
    workspaceTerminalSession.snapshots,
  ]);

  useEffect(() => {
    pendingTerminalInputRef.current = [];
    const nextTerminalId = isScreenFocused ? terminalId : null;
    streamControllerRef.current?.setTerminal({
      terminalId: nextTerminalId,
    });
  }, [isScreenFocused, terminalId]);

  const enqueuePendingTerminalInput = useCallback((entry: PendingTerminalInput) => {
    const queue = pendingTerminalInputRef.current;
    queue.push(entry);
    if (queue.length > 512) {
      queue.splice(0, queue.length - 512);
    }
  }, []);

  const dispatchTerminalInputEntry = useCallback(
    (entry: PendingTerminalInput): boolean => {
      if (!client) {
        return false;
      }

      const currentTerminalId = terminalIdRef.current;
      if (!currentTerminalId) {
        return false;
      }

      if (entry.type === "data") {
        client.sendTerminalInput(currentTerminalId, {
          type: "input",
          data: entry.data,
        });
        return true;
      }

      const encoded = encodeTerminalKeyInput(entry.input);
      if (encoded.length === 0) {
        return true;
      }
      client.sendTerminalInput(currentTerminalId, {
        type: "input",
        data: encoded,
      });
      return true;
    },
    [client],
  );

  const flushPendingTerminalInput = useCallback(() => {
    const queue = pendingTerminalInputRef.current;
    if (queue.length === 0) {
      return;
    }

    let sentCount = 0;
    while (sentCount < queue.length) {
      const entry = queue[sentCount];
      if (!entry) {
        break;
      }
      if (!dispatchTerminalInputEntry(entry)) {
        break;
      }
      sentCount += 1;
    }

    if (sentCount > 0) {
      queue.splice(0, sentCount);
    }
  }, [dispatchTerminalInputEntry]);

  useEffect(() => {
    if (!isAttaching && !streamError) {
      flushPendingTerminalInput();
    }
  }, [flushPendingTerminalInput, isAttaching, streamError]);

  const clearPendingModifiers = useCallback(() => {
    setModifiers({ ...EMPTY_MODIFIERS });
  }, []);

  const sendTerminalKey = useCallback(
    (input: {
      key: string;
      ctrl: boolean;
      shift: boolean;
      alt: boolean;
      meta?: boolean;
    }): boolean => {
      if (!client || !terminalIdRef.current) {
        enqueuePendingTerminalInput({
          type: "key",
          input: {
            key: normalizeTerminalTransportKey(input.key),
            ctrl: input.ctrl,
            shift: input.shift,
            alt: input.alt,
            meta: input.meta,
          },
        });
        return true;
      }

      const normalizedKey = normalizeTerminalTransportKey(input.key);
      const pendingEntry: PendingTerminalInput = {
        type: "key",
        input: {
          key: normalizedKey,
          ctrl: input.ctrl,
          shift: input.shift,
          alt: input.alt,
          meta: input.meta,
        },
      };
      if (!dispatchTerminalInputEntry(pendingEntry)) {
        enqueuePendingTerminalInput(pendingEntry);
      }
      return true;
    },
    [client, dispatchTerminalInputEntry, enqueuePendingTerminalInput],
  );

  const handleTerminalData = useCallback(
    async (data: string) => {
      if (data.length === 0) {
        return;
      }

      if (hasPendingTerminalModifiers(modifiers)) {
        const pendingResolution = resolvePendingModifierDataInput({
          data,
          pendingModifiers: modifiers,
        });
        if (pendingResolution.mode === "key") {
          if (
            sendTerminalKey({
              key: pendingResolution.key,
              ctrl: modifiers.ctrl,
              shift: modifiers.shift,
              alt: modifiers.alt,
              meta: false,
            })
          ) {
            clearPendingModifiers();
            return;
          }
        }

        if (pendingResolution.clearPendingModifiers) {
          clearPendingModifiers();
        }
      }

      if (!client || !terminalIdRef.current) {
        enqueuePendingTerminalInput({
          type: "data",
          data,
        });
        return;
      }
      const pendingEntry: PendingTerminalInput = {
        type: "data",
        data,
      };
      if (!dispatchTerminalInputEntry(pendingEntry)) {
        enqueuePendingTerminalInput(pendingEntry);
      }
    },
    [
      clearPendingModifiers,
      client,
      dispatchTerminalInputEntry,
      modifiers.alt,
      modifiers.ctrl,
      modifiers.shift,
      sendTerminalKey,
      enqueuePendingTerminalInput,
    ],
  );

  const handleTerminalResize = useStableEvent((input: { rows: number; cols: number }) => {
    const { rows, cols } = input;
    if (
      !client ||
      !terminalId ||
      !isPaneFocused ||
      !isScreenFocused ||
      !isAppVisible ||
      rows <= 0 ||
      cols <= 0
    ) {
      return;
    }
    const normalizedRows = Math.floor(rows);
    const normalizedCols = Math.floor(cols);
    const previous = lastReportedSizeRef.current;
    if (previous && previous.rows === normalizedRows && previous.cols === normalizedCols) {
      return;
    }
    lastReportedSizeRef.current = { rows: normalizedRows, cols: normalizedCols };
    client.sendTerminalInput(terminalId, {
      type: "resize",
      rows: normalizedRows,
      cols: normalizedCols,
    });
  });

  const handleTerminalKey = useCallback(
    async (input: { key: string; ctrl: boolean; shift: boolean; alt: boolean; meta: boolean }) => {
      sendTerminalKey(input);
    },
    [sendTerminalKey],
  );

  const handlePendingModifiersConsumed = useCallback(() => {
    clearPendingModifiers();
  }, [clearPendingModifiers]);

  const toggleModifier = useCallback(
    (modifier: keyof ModifierState) => {
      setModifiers((current) => ({ ...current, [modifier]: !current[modifier] }));
      requestTerminalFocus();
    },
    [requestTerminalFocus],
  );

  const sendVirtualKey = useCallback(
    (key: string) => {
      sendTerminalKey({
        key,
        ctrl: modifiers.ctrl,
        shift: modifiers.shift,
        alt: modifiers.alt,
        meta: false,
      });
      clearPendingModifiers();
      requestTerminalFocus();
    },
    [
      clearPendingModifiers,
      modifiers.alt,
      modifiers.ctrl,
      modifiers.shift,
      requestTerminalFocus,
      sendTerminalKey,
    ],
  );

  if (!client || !isConnected) {
    return (
      <View style={styles.centerState}>
        <Text style={styles.stateText}>Host is not connected</Text>
      </View>
    );
  }

  return (
    <Animated.View style={[styles.container, keyboardPaddingStyle]}>
      <View style={styles.outputContainer}>
        {isScreenFocused ? (
          <View style={styles.terminalGestureContainer}>
            <TerminalEmulator
              ref={emulatorRef}
              dom={{
                style: { flex: 1 },
                matchContents: false,
                scrollEnabled: true,
                nestedScrollEnabled: true,
                overScrollMode: "never",
                bounces: false,
                automaticallyAdjustContentInsets: false,
                contentInsetAdjustmentBehavior: "never",
              }}
              streamKey={`${scopeKey}:${terminalId}`}
              testId="terminal-surface"
              xtermTheme={xtermTheme}
              swipeGesturesEnabled={swipeGesturesEnabled}
              initialSnapshot={initialSnapshot}
              onSwipeRight={() => {
                if (!swipeGesturesEnabled) {
                  return;
                }
                openAgentList();
              }}
              onSwipeLeft={() => {
                if (!swipeGesturesEnabled) {
                  return;
                }
                openFileExplorer();
              }}
              onInput={handleTerminalData}
              onResize={handleTerminalResize}
              onTerminalKey={handleTerminalKey}
              onPendingModifiersConsumed={handlePendingModifiersConsumed}
              pendingModifiers={modifiers}
              focusRequestToken={focusRequestToken}
              resizeRequestToken={resizeRequestToken}
            />
          </View>
        ) : (
          <View style={styles.terminalGestureContainer} />
        )}

        {isAttaching && isScreenFocused ? (
          <View style={styles.attachOverlay} pointerEvents="none" testID="terminal-attach-loading">
            <ActivityIndicator size="small" color={theme.colors.foregroundMuted} />
          </View>
        ) : null}
      </View>

      {streamError ? (
        <View style={styles.errorRow}>
          <Text style={styles.statusError} numberOfLines={2}>
            {streamError}
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
                  <Text
                    style={[
                      styles.keyButtonText,
                      modifiers[modifier] && styles.keyButtonTextActive,
                    ]}
                  >
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
    </Animated.View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    minHeight: 0,
    backgroundColor: theme.colors.surface0,
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
    ...StyleSheet.absoluteFillObject,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(0, 0, 0, 0.16)",
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

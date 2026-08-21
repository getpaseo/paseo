import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { useRetainedPanelActive } from "@/components/retained-panel";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as Clipboard from "expo-clipboard";
import { Pressable, Text, View, type PressableStateCallbackType } from "react-native";
import Animated, { runOnJS, useAnimatedReaction } from "react-native-reanimated";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { Keyboard as KeyboardIcon, KeyboardOff as KeyboardOffIcon } from "lucide-react-native";
import type { TerminalKeyInput } from "@getpaseo/protocol/terminal-key-input";
import type { TerminalState } from "@getpaseo/protocol/messages";
import {
  DEFAULT_TERMINAL_INPUT_MODE_STATE,
  type TerminalInputModeState,
} from "@getpaseo/protocol/terminal-input-mode";
import { useTranslation } from "react-i18next";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { useKeyboardShiftStyle } from "@/hooks/use-keyboard-shift-style";
import { useAppActivelyVisible } from "@/hooks/use-app-visible";
import { useStableEvent } from "@/hooks/use-stable-event";
import {
  hasPendingTerminalModifiers,
  resolvePendingModifierDataInput,
} from "@/utils/terminal-keys";
import {
  createTerminalKeyInput,
  dispatchTerminalKeyInput,
  type TerminalKeyModifierState,
} from "@/terminal/runtime/terminal-key-dispatch";
import { useTerminalModifiers } from "@/terminal/runtime/use-terminal-modifiers";
import {
  getTerminalVirtualKeyboardControlId,
  shouldShowTerminalFloatingCopyAction,
  shouldShowTerminalPasteAction,
  TERMINAL_VIRTUAL_KEYBOARD_ROWS,
  type TerminalVirtualKeyboardControl,
} from "@/terminal/runtime/terminal-virtual-keyboard";
import { pasteTerminalClipboard } from "@/terminal/runtime/terminal-paste";
import { getWorkspaceTerminalSession } from "@/terminal/runtime/workspace-terminal-session";
import {
  EMPTY_FOCUS_CLAIM_STATE,
  canRequestFocusClaim,
  reconcileFocusClaim,
  resolveTerminalResizeClaim,
  settleFocusClaim,
} from "./terminal-pane-focus-claim";
import {
  TerminalStreamController,
  type TerminalStreamControllerStatus,
} from "@/terminal/runtime/terminal-stream-controller";
import { resolveTerminalRestoreOptions } from "@/terminal/runtime/terminal-restore-options";
import { usePanelStore } from "@/stores/panel-store";
import { useBlockMobilePanelOpenGestures } from "@/mobile-panels/provider";
import { useSessionStore } from "@/stores/session-store";
import { toXtermTheme } from "@/utils/to-xterm-theme";
import TerminalEmulator, { type TerminalEmulatorHandle } from "./terminal-emulator";
import { TerminalFloatingCopyAction, TerminalPasteAction } from "./terminal-copy-paste-actions";
import {
  createTerminalResizeDebouncer,
  type TerminalResizeRequest,
} from "./terminal-resize-debouncer";
import { useIsCompactFormFactor } from "@/constants/layout";
import { isNative } from "@/constants/platform";
import {
  applyTerminalRendererReadyChange,
  resolveTerminalStreamTarget,
  shouldReplayTerminalSnapshotForRenderer,
  shouldShowTerminalLoadingOverlay,
  type TerminalRendererReadyChange,
} from "@/utils/terminal-renderer-readiness";
import { useAppSettings } from "@/hooks/use-settings";
import { classifyForResolution, fetchDaemonResolution } from "@/assistant-file-links/resolver";
import type {
  TerminalLocalFileLinkSource,
  TerminalLocalFileLinkTarget,
} from "@/terminal/local-links/terminal-local-link-provider";
import {
  normalizeWorkspaceFileLocation,
  type OpenFileDisposition,
  type WorkspaceFileOpenRequest,
} from "@/workspace/file-open";

interface TerminalPaneProps {
  serverId: string;
  cwd: string;
  terminalId: string;
  isWorkspaceFocused: boolean;
  isPaneFocused: boolean;
  onOpenFileExplorer: () => void;
  onOpenWorkspaceFile: (request: WorkspaceFileOpenRequest) => void;
}

const TERMINAL_REFIT_DELAYS_MS = [0, 48, 144, 320];
const TERMINAL_RESIZE_DEBOUNCE_MS = 100;

const MODIFIER_LABELS = {
  ctrl: "Ctrl",
  shift: "Shift",
  alt: "Alt",
} as const;

type ModifierState = TerminalKeyModifierState;

type PendingTerminalInput =
  | {
      type: "data";
      data: string;
    }
  | {
      type: "key";
      input: TerminalKeyInput;
    };

function terminalScopeKey(input: { serverId: string; cwd: string }): string {
  return `${input.serverId}:${input.cwd}`;
}

interface ModifierButtonProps {
  modifier: keyof ModifierState;
  active: boolean;
  onToggle: (modifier: keyof ModifierState) => void;
}

function ModifierButton({ modifier, active, onToggle }: ModifierButtonProps) {
  const handlePress = useCallback(() => onToggle(modifier), [onToggle, modifier]);
  const pressableStyle = useCallback(
    ({ hovered, pressed }: PressableStateCallbackType & { hovered?: boolean }) => [
      styles.keyButton,
      active && styles.keyButtonActive,
      (Boolean(hovered) || pressed) && styles.keyButtonHovered,
    ],
    [active],
  );
  const textStyle = useMemo(
    () => [styles.keyButtonText, active && styles.keyButtonTextActive],
    [active],
  );
  return (
    <Pressable testID={`terminal-key-${modifier}`} onPress={handlePress} style={pressableStyle}>
      <Text style={textStyle}>{MODIFIER_LABELS[modifier]}</Text>
    </Pressable>
  );
}

interface VirtualKeyButtonProps {
  id: string;
  label: string;
  keyValue: string;
  onSend: (key: string) => void;
}

function VirtualKeyButton({ id, label, keyValue, onSend }: VirtualKeyButtonProps) {
  const handlePress = useCallback(() => onSend(keyValue), [onSend, keyValue]);
  const pressableStyle = useCallback(
    ({ hovered, pressed }: PressableStateCallbackType & { hovered?: boolean }) => [
      styles.keyButton,
      (Boolean(hovered) || pressed) && styles.keyButtonHovered,
    ],
    [],
  );
  return (
    <Pressable testID={`terminal-key-${id}`} onPress={handlePress} style={pressableStyle}>
      <Text style={styles.keyButtonText}>{label}</Text>
    </Pressable>
  );
}

interface KeyboardToggleButtonProps {
  isKeyboardVisible: boolean;
  iconColor: string;
  onToggle: () => void;
}

function KeyboardToggleButton({
  isKeyboardVisible,
  iconColor,
  onToggle,
}: KeyboardToggleButtonProps) {
  const label = isKeyboardVisible ? "Hide keyboard" : "Show keyboard";
  const Icon = isKeyboardVisible ? KeyboardOffIcon : KeyboardIcon;
  const pressableStyle = useCallback(
    ({ hovered, pressed }: PressableStateCallbackType & { hovered?: boolean }) => [
      styles.keyButton,
      (Boolean(hovered) || pressed) && styles.keyButtonHovered,
    ],
    [],
  );

  return (
    <Pressable
      accessibilityLabel={label}
      accessibilityRole="button"
      testID="terminal-keyboard-toggle"
      onPress={onToggle}
      style={pressableStyle}
    >
      <Icon color={iconColor} size={16} />
    </Pressable>
  );
}

export function TerminalPane({
  serverId,
  cwd,
  terminalId,
  isWorkspaceFocused,
  isPaneFocused,
  onOpenFileExplorer,
  onOpenWorkspaceFile,
}: TerminalPaneProps) {
  const { t } = useTranslation();
  const retainedPanelActive = useRetainedPanelActive();
  const isAppActivelyVisible = useAppActivelyVisible();
  const { theme } = useUnistyles();
  const { settings } = useAppSettings();
  const xtermTheme = useMemo(() => toXtermTheme(theme.colors.terminal), [theme]);
  const terminalFontFamily = useMemo(() => {
    const trimmed = settings.monoFontFamily.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }, [settings.monoFontFamily]);
  const isMobile = useIsCompactFormFactor();
  const mobileView = usePanelStore((state) => state.mobilePanel.target);
  const showMobileAgentList = usePanelStore((state) => state.showMobileAgentList);
  const swipeGesturesEnabled = isMobile;
  const { shift: keyboardShift, style: keyboardPaddingStyle } = useKeyboardShiftStyle({
    mode: "padding",
    enabled: isMobile,
  });
  const [keyboardInset, setKeyboardInset] = useState(0);
  const [isKeyboardVisible, setIsKeyboardVisible] = useState(false);

  const client = useHostRuntimeClient(serverId);
  const isConnected = useHostRuntimeIsConnected(serverId);
  const isTerminalPresented = retainedPanelActive && isWorkspaceFocused;
  const supportsTerminalRestoreModes = useSessionStore(
    (state) => state.sessions[serverId]?.serverInfo?.features?.["terminal-restore-modes"] === true,
  );
  const supportsTerminalInputModeReplay = useSessionStore(
    (state) =>
      state.sessions[serverId]?.serverInfo?.features?.["terminal-input-mode-replay"] === true,
  );
  const supportsTerminalSizeOwnership = useSessionStore(
    (state) => state.sessions[serverId]?.serverInfo?.features?.["terminal-size-ownership"] === true,
  );
  const setFocusedTerminalId = useSessionStore((state) => state.setFocusedTerminalId);

  const scopeKey = useMemo(() => terminalScopeKey({ serverId, cwd }), [serverId, cwd]);
  const terminalStreamKey = useMemo(() => `${scopeKey}:${terminalId}`, [scopeKey, terminalId]);
  // Keep the latest measured size for whichever client currently owns the pane,
  // but only dedupe resizes that this specific client has already pushed.
  const measuredTerminalSizeRef = useRef<{ rows: number; cols: number } | null>(null);
  const lastSentTerminalSizeRef = useRef<{ rows: number; cols: number } | null>(null);
  const streamControllerRef = useRef<TerminalStreamController | null>(null);
  const workspaceTerminalSession = useMemo(
    () => getWorkspaceTerminalSession({ scopeKey }),
    [scopeKey],
  );
  const [isAttaching, setIsAttaching] = useState(false);
  const [streamError, setStreamError] = useState<string | null>(null);
  const [rendererReadyStreamKey, setRendererReadyStreamKey] = useState<string | null>(null);
  const {
    modifiers,
    readModifiers,
    clearModifiers,
    toggleModifier: toggleModifierState,
  } = useTerminalModifiers();
  const [hasSelection, setHasSelection] = useState(false);
  const [hasClipboardText, setHasClipboardText] = useState(false);
  const [isKeyboardToggleVisible, setIsKeyboardToggleVisible] = useState(false);
  const [focusRequestToken, setFocusRequestToken] = useState(0);
  const [resizeRequestToken, setResizeRequestToken] = useState(0);
  useBlockMobilePanelOpenGestures(isMobile && isWorkspaceFocused && isPaneFocused && hasSelection);
  const emulatorRef = useRef<TerminalEmulatorHandle>(null);
  const terminalIdRef = useRef<string>(terminalId);
  const terminalPresentedRef = useRef(isTerminalPresented);
  terminalPresentedRef.current = isTerminalPresented;
  const inputModeRef = useRef<TerminalInputModeState>(DEFAULT_TERMINAL_INPUT_MODE_STATE);
  const pendingTerminalInputRef = useRef<PendingTerminalInput[]>([]);
  const keyboardRefitTimeoutsRef = useRef<Array<ReturnType<typeof setTimeout>>>([]);
  const lastAutoFocusKeyRef = useRef<string | null>(null);
  const paneFocusResizeClaimRef = useRef(EMPTY_FOCUS_CLAIM_STATE);
  const initialSnapshot = workspaceTerminalSession.snapshots.get({ terminalId });

  useEffect(() => {
    terminalIdRef.current = terminalId;
    inputModeRef.current = DEFAULT_TERMINAL_INPUT_MODE_STATE;
    setHasSelection(false);
  }, [terminalId]);

  const refreshClipboardAvailability = useCallback(async () => {
    if (!isMobile) {
      setHasClipboardText(false);
      return;
    }
    try {
      const hasText = await Clipboard.hasStringAsync();
      setHasClipboardText(hasText);
    } catch {
      setHasClipboardText(false);
    }
  }, [isMobile]);

  useEffect(() => {
    void refreshClipboardAvailability();
  }, [refreshClipboardAvailability, isAppActivelyVisible]);

  useEffect(() => {
    void refreshClipboardAvailability();
  }, [keyboardInset, refreshClipboardAvailability]);

  useEffect(() => {
    setIsKeyboardToggleVisible(isKeyboardVisible);
  }, [isKeyboardVisible]);

  const handleSelectionChange = useCallback((nextHasSelection: boolean) => {
    setHasSelection(nextHasSelection);
  }, []);

  const requestTerminalFocus = useCallback(() => {
    setFocusRequestToken((current) => current + 1);
  }, []);
  const requestTerminalReflow = useCallback(() => {
    setResizeRequestToken((current) => current + 1);
  }, []);
  useEffect(() => {
    if (!isMobile || !isWorkspaceFocused || mobileView === "agent") {
      return;
    }
    emulatorRef.current?.blur();
  }, [isMobile, isWorkspaceFocused, mobileView]);
  const handleRendererReadyChange = useCallback(
    (change: TerminalRendererReadyChange) => {
      setRendererReadyStreamKey((current) => applyTerminalRendererReadyChange(current, change));
      if (!shouldReplayTerminalSnapshotForRenderer({ change, terminalStreamKey })) {
        return;
      }

      const snapshot = workspaceTerminalSession.snapshots.get({ terminalId });
      if (snapshot) {
        emulatorRef.current?.renderSnapshot(snapshot);
      }
    },
    [terminalId, terminalStreamKey, workspaceTerminalSession.snapshots],
  );

  useEffect(() => {
    if (isMobile || !isPaneFocused || !terminalId) {
      lastAutoFocusKeyRef.current = null;
      return;
    }
    if (!isWorkspaceFocused) {
      return;
    }
    const focusKey = `${scopeKey}:${terminalId}`;
    if (lastAutoFocusKeyRef.current !== focusKey) {
      lastAutoFocusKeyRef.current = focusKey;
      requestTerminalFocus();
    }
  }, [isMobile, isPaneFocused, isWorkspaceFocused, requestTerminalFocus, scopeKey, terminalId]);

  useEffect(() => {
    const canRequest = canRequestFocusClaim({
      isWorkspaceFocused: isTerminalPresented,
      isPaneFocused,
      isAppActivelyVisible,
      isClientReady: client !== null,
      isConnected,
      isRendererReady: rendererReadyStreamKey === terminalStreamKey,
    });
    const step = reconcileFocusClaim(paneFocusResizeClaimRef.current, {
      key: !isPaneFocused || !terminalId ? null : `${scopeKey}:${terminalId}`,
      canRequest,
    });
    paneFocusResizeClaimRef.current = step.state;
    if (step.shouldRequest) {
      lastSentTerminalSizeRef.current = null;
      requestTerminalReflow();
      emulatorRef.current?.claimSize();
    }
  }, [
    client,
    isAppActivelyVisible,
    isConnected,
    isPaneFocused,
    isTerminalPresented,
    rendererReadyStreamKey,
    requestTerminalReflow,
    scopeKey,
    terminalId,
    terminalStreamKey,
  ]);

  const handleTerminalFocus = useCallback(() => {
    if (isWorkspaceFocused && isPaneFocused) {
      setFocusedTerminalId(serverId, terminalId);
    }
    lastSentTerminalSizeRef.current = null;
    requestTerminalReflow();
    emulatorRef.current?.claimSize();
  }, [
    isPaneFocused,
    isWorkspaceFocused,
    requestTerminalReflow,
    serverId,
    setFocusedTerminalId,
    terminalId,
  ]);

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
    keyboardRefitTimeoutsRef.current = TERMINAL_REFIT_DELAYS_MS.map((delayMs, index) =>
      setTimeout(() => {
        requestTerminalReflow();
        if (index === TERMINAL_REFIT_DELAYS_MS.length - 1) {
          emulatorRef.current?.claimSize();
        }
      }, delayMs),
    );
  }, [clearKeyboardRefitTimeouts, requestTerminalReflow]);

  const handleKeyboardChange = useCallback(
    (nextShift: number) => {
      setKeyboardInset(isMobile ? nextShift : 0);
      setIsKeyboardVisible(nextShift > 0);
      pulseKeyboardRefits();
    },
    [isMobile, pulseKeyboardRefits],
  );

  useEffect(() => {
    return () => clearKeyboardRefitTimeouts();
  }, [clearKeyboardRefitTimeouts]);

  useAnimatedReaction(
    () => Math.round(keyboardShift.value),
    (next, prev) => {
      if (next === prev) {
        return;
      }
      runOnJS(handleKeyboardChange)(next);
    },
    [handleKeyboardChange],
  );

  useEffect(() => {
    if (!client || !isConnected || !isWorkspaceFocused) {
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
        clearModifiers();
      }
      streamControllerRef.current?.handleTerminalExit({
        terminalId: exitedTerminalId,
      });
    });
  }, [clearModifiers, client, isConnected, isWorkspaceFocused, workspaceTerminalSession.snapshots]);

  useEffect(() => {
    measuredTerminalSizeRef.current = null;
    lastSentTerminalSizeRef.current = null;
  }, [scopeKey]);

  const handleStreamControllerStatus = useCallback((status: TerminalStreamControllerStatus) => {
    setIsAttaching(status.isAttaching);
    setStreamError(status.error);
  }, []);

  const getPreferredStreamSize = useStableEvent(() => {
    if (
      !canRequestFocusClaim({
        isWorkspaceFocused: terminalPresentedRef.current,
        isPaneFocused,
        isAppActivelyVisible,
        isClientReady: client !== null,
        isConnected,
        isRendererReady: rendererReadyStreamKey === terminalStreamKey,
      })
    ) {
      return null;
    }
    return measuredTerminalSizeRef.current;
  });

  const handleStreamOutput = useStableEvent(
    ({ terminalId: outputTerminalId, data }: { terminalId: string; data: Uint8Array }) => {
      if (terminalIdRef.current !== outputTerminalId) {
        return;
      }
      emulatorRef.current?.writeOutput(data);
    },
  );

  const handleStreamRestore = useStableEvent(
    ({ terminalId: restoreTerminalId, data }: { terminalId: string; data: Uint8Array }) => {
      workspaceTerminalSession.snapshots.clear({ terminalId: restoreTerminalId });
      if (terminalIdRef.current !== restoreTerminalId) {
        return;
      }
      emulatorRef.current?.restoreOutput(data);
    },
  );

  const handleStreamSnapshot = useStableEvent(
    ({ terminalId: snapshotTerminalId, state }: { terminalId: string; state: TerminalState }) => {
      workspaceTerminalSession.snapshots.set({ terminalId: snapshotTerminalId, state });
      if (terminalIdRef.current !== snapshotTerminalId) {
        return;
      }
      emulatorRef.current?.renderSnapshot(state);
    },
  );

  const getStreamRestoreOptions = useStableEvent(() =>
    resolveTerminalRestoreOptions({
      supportsTerminalRestoreModes,
      canClaimSize: canRequestFocusClaim({
        isWorkspaceFocused: terminalPresentedRef.current,
        isPaneFocused,
        isAppActivelyVisible,
        isClientReady: client !== null,
        isConnected,
        isRendererReady: rendererReadyStreamKey === terminalStreamKey,
      }),
      size: measuredTerminalSizeRef.current,
    }),
  );

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
      getPreferredSize: getPreferredStreamSize,
      onOutput: handleStreamOutput,
      onRestore: handleStreamRestore,
      onSnapshot: handleStreamSnapshot,
      getRestoreOptions: getStreamRestoreOptions,
      onStatusChange: handleStreamControllerStatus,
    });

    streamControllerRef.current = controller;

    return () => {
      controller.dispose();
      if (streamControllerRef.current === controller) {
        streamControllerRef.current = null;
      }
    };
  }, [
    client,
    getPreferredStreamSize,
    getStreamRestoreOptions,
    handleStreamControllerStatus,
    handleStreamOutput,
    handleStreamRestore,
    handleStreamSnapshot,
    isConnected,
  ]);

  useEffect(() => {
    pendingTerminalInputRef.current = [];
    const nextTerminalId = resolveTerminalStreamTarget({
      terminalId,
      terminalStreamKey,
      rendererReadyStreamKey,
      isWorkspaceFocused,
    });
    streamControllerRef.current?.setTerminal({
      terminalId: nextTerminalId,
    });
  }, [
    client,
    isConnected,
    isWorkspaceFocused,
    rendererReadyStreamKey,
    terminalId,
    terminalStreamKey,
  ]);

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

      dispatchTerminalKeyInput({
        keyInput: entry.input,
        inputMode: inputModeRef.current,
        sendData: (data) =>
          client.sendTerminalInput(currentTerminalId, {
            type: "input",
            data,
          }),
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
    clearModifiers();
  }, [clearModifiers]);

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
            ...createTerminalKeyInput({
              key: input.key,
              modifiers: {
                ctrl: input.ctrl,
                shift: input.shift,
                alt: input.alt,
              },
              meta: input.meta,
            }),
          },
        });
        return true;
      }

      const pendingEntry: PendingTerminalInput = {
        type: "key",
        input: createTerminalKeyInput({
          key: input.key,
          modifiers: {
            ctrl: input.ctrl,
            shift: input.shift,
            alt: input.alt,
          },
          meta: input.meta,
        }),
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

      const currentModifiers = readModifiers();
      if (hasPendingTerminalModifiers(currentModifiers)) {
        const pendingResolution = resolvePendingModifierDataInput({
          data,
          pendingModifiers: currentModifiers,
        });
        if (pendingResolution.mode === "key") {
          if (
            sendTerminalKey({
              key: pendingResolution.key,
              ctrl: currentModifiers.ctrl,
              shift: currentModifiers.shift,
              alt: currentModifiers.alt,
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
      sendTerminalKey,
      enqueuePendingTerminalInput,
      readModifiers,
    ],
  );

  const sendTerminalResize = useStableEvent((input: TerminalResizeRequest) => {
    const nextSize = { rows: input.rows, cols: input.cols };
    const claim = resolveTerminalResizeClaim({
      size: nextSize,
      previousSentSize: lastSentTerminalSizeRef.current,
      shouldClaim: input.shouldClaim,
      forceClaim: input.forceClaim ?? false,
      supportsTerminalSizeOwnership,
      readiness: {
        isWorkspaceFocused: isTerminalPresented,
        isPaneFocused,
        isAppActivelyVisible,
        isClientReady: client !== null,
        isConnected,
        isRendererReady: rendererReadyStreamKey === terminalStreamKey,
      },
    });
    let sent = false;
    if (client && terminalId && claim.shouldSend) {
      lastSentTerminalSizeRef.current = nextSize;
      client.sendTerminalInput(terminalId, {
        type: "resize",
        rows: input.rows,
        cols: input.cols,
        intent: claim.intent,
      });
      sent = true;
    }
    const requestedKey = paneFocusResizeClaimRef.current.requestedKey;
    if (requestedKey && claim.intent === "claim") {
      paneFocusResizeClaimRef.current = settleFocusClaim(paneFocusResizeClaimRef.current, {
        key: requestedKey,
        sent,
      });
    }
  });

  const terminalResizeDebouncer = useMemo(
    () =>
      createTerminalResizeDebouncer({
        delayMs: TERMINAL_RESIZE_DEBOUNCE_MS,
        emit: sendTerminalResize,
      }),
    [sendTerminalResize],
  );

  useEffect(
    () => () => terminalResizeDebouncer.cancel(),
    [terminalResizeDebouncer, terminalStreamKey],
  );

  const handleTerminalResize = useStableEvent((input: TerminalResizeRequest) => {
    if (input.rows <= 0 || input.cols <= 0) {
      return;
    }
    const nextResize = {
      ...input,
      rows: Math.floor(input.rows),
      cols: Math.floor(input.cols),
    };
    measuredTerminalSizeRef.current = { rows: nextResize.rows, cols: nextResize.cols };
    terminalResizeDebouncer.schedule(nextResize);
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

  const handleTerminalPaste = useCallback(() => {
    requestTerminalReflow();
    void pasteTerminalClipboard({
      clipboard: { readText: () => Clipboard.getStringAsync() },
      terminal: { paste: (text) => emulatorRef.current?.paste(text) },
    }).then(() => refreshClipboardAvailability());
  }, [requestTerminalReflow, refreshClipboardAvailability]);

  const handleTerminalCopy = useCallback(() => {
    void emulatorRef.current
      ?.copySelection({
        writeText: async (text: string) => {
          await Clipboard.setStringAsync(text);
        },
      })
      .then(() => refreshClipboardAvailability());
  }, [refreshClipboardAvailability]);

  const handleKeyboardToggle = useCallback(() => {
    if (isKeyboardToggleVisible) {
      setIsKeyboardToggleVisible(false);
      emulatorRef.current?.blur();
      requestTerminalReflow();
      return;
    }

    setIsKeyboardToggleVisible(true);
    emulatorRef.current?.showKeyboard();
    requestTerminalReflow();
  }, [isKeyboardToggleVisible, requestTerminalReflow]);

  const handleInputModeChange = useCallback((state: TerminalInputModeState) => {
    inputModeRef.current = state;
  }, []);
  const handleResolveLocalFileLink = useCallback(
    async (source: TerminalLocalFileLinkSource): Promise<TerminalLocalFileLinkTarget | null> => {
      const resolution = classifyForResolution(
        { href: source.text, text: source.text, sourceType: "inline-code" },
        { workspaceRoot: cwd },
      );
      if (resolution.kind === "resolved") {
        return resolution.value.kind === "file" ? resolution.value.target : null;
      }
      if (!client) {
        return null;
      }
      try {
        return await fetchDaemonResolution({
          ambiguousQuery: resolution.ambiguousQuery,
          token: resolution.token,
          target: resolution.target,
          workspaceRoot: cwd,
          getDirectorySuggestions: (input) => client.getDirectorySuggestions(input),
        });
      } catch {
        return null;
      }
    },
    [client, cwd],
  );
  const handleOpenLocalFileLink = useCallback(
    (target: TerminalLocalFileLinkTarget, disposition: OpenFileDisposition) => {
      const location = normalizeWorkspaceFileLocation(target);
      if (!location) {
        return;
      }
      onOpenWorkspaceFile({ location, disposition });
    },
    [onOpenWorkspaceFile],
  );

  const toggleModifier = useCallback(
    (modifier: keyof ModifierState) => {
      toggleModifierState(modifier);
      requestTerminalFocus();
      requestTerminalReflow();
    },
    [requestTerminalFocus, requestTerminalReflow, toggleModifierState],
  );

  const sendVirtualKey = useCallback(
    (key: string) => {
      const currentModifiers = readModifiers();
      sendTerminalKey({
        key,
        ctrl: currentModifiers.ctrl,
        shift: currentModifiers.shift,
        alt: currentModifiers.alt,
        meta: false,
      });
      clearPendingModifiers();
      requestTerminalFocus();
      requestTerminalReflow();
    },
    [
      clearPendingModifiers,
      requestTerminalFocus,
      requestTerminalReflow,
      readModifiers,
      sendTerminalKey,
    ],
  );

  const containerStyle = useMemo(
    () => [styles.container, keyboardPaddingStyle],
    [keyboardPaddingStyle],
  );

  const handleSwipeRight = useCallback(() => {
    if (!swipeGesturesEnabled) return;
    emulatorRef.current?.blur();
    showMobileAgentList();
  }, [swipeGesturesEnabled, showMobileAgentList]);

  const handleSwipeLeft = useCallback(() => {
    if (!swipeGesturesEnabled) return;
    emulatorRef.current?.blur();
    onOpenFileExplorer();
  }, [swipeGesturesEnabled, onOpenFileExplorer]);
  const showPasteAction = shouldShowTerminalPasteAction({ isNative });
  const showFloatingCopyAction = shouldShowTerminalFloatingCopyAction({
    hasSelection,
    isNative,
  });
  const keyboardToggleIconColor = theme.colors.foregroundMuted;

  const renderVirtualKeyboardControl = (control: TerminalVirtualKeyboardControl) => {
    const controlId = getTerminalVirtualKeyboardControlId(control);
    switch (control.type) {
      case "key":
        return (
          <VirtualKeyButton
            key={controlId}
            id={control.button.id}
            label={control.button.label}
            keyValue={control.button.key}
            onSend={sendVirtualKey}
          />
        );
      case "modifier":
        return (
          <ModifierButton
            key={controlId}
            modifier={control.modifier}
            active={modifiers[control.modifier]}
            onToggle={toggleModifier}
          />
        );
      case "paste":
        return showPasteAction ? (
          <TerminalPasteAction
            key={controlId}
            hasClipboardText={hasClipboardText}
            onPaste={handleTerminalPaste}
          />
        ) : null;
      case "keyboardToggle":
        return (
          <KeyboardToggleButton
            key={controlId}
            iconColor={keyboardToggleIconColor}
            isKeyboardVisible={isKeyboardToggleVisible}
            onToggle={handleKeyboardToggle}
          />
        );
    }
  };
  const showLoadingOverlay = shouldShowTerminalLoadingOverlay({
    isWorkspaceFocused: isTerminalPresented,
    hasStreamError: Boolean(streamError),
    isAttaching,
    rendererReadyStreamKey,
    terminalStreamKey,
  });

  if (!client || !isConnected) {
    return (
      <View style={styles.centerState}>
        <Text style={styles.stateText}>{t("workspace.terminal.hostDisconnected")}</Text>
      </View>
    );
  }

  return (
    <Animated.View style={containerStyle}>
      <View style={styles.outputContainer}>
        <View style={styles.terminalGestureContainer}>
          <TerminalEmulator
            ref={emulatorRef}
            dom={TERMINAL_EMULATOR_DOM_PROPS}
            streamKey={terminalStreamKey}
            supportsTerminalInputModeReplay={supportsTerminalInputModeReplay}
            testId="terminal-surface"
            xtermTheme={xtermTheme}
            scrollbackLines={settings.terminalScrollbackLines}
            fontFamily={terminalFontFamily}
            fontSize={settings.codeFontSize}
            keyboardInset={keyboardInset}
            isKeyboardVisible={isKeyboardVisible}
            swipeGesturesEnabled={swipeGesturesEnabled}
            initialSnapshot={initialSnapshot}
            onRendererReadyChange={handleRendererReadyChange}
            onSwipeRight={handleSwipeRight}
            onSwipeLeft={handleSwipeLeft}
            onInput={handleTerminalData}
            onFocus={handleTerminalFocus}
            onResize={handleTerminalResize}
            onTerminalKey={handleTerminalKey}
            onInputModeChange={handleInputModeChange}
            onSelectionChange={handleSelectionChange}
            onResolveLocalFileLink={handleResolveLocalFileLink}
            onOpenLocalFileLink={handleOpenLocalFileLink}
            onPendingModifiersConsumed={handlePendingModifiersConsumed}
            pendingModifiers={modifiers}
            focusRequestToken={focusRequestToken}
            resizeRequestToken={resizeRequestToken}
          />
        </View>

        {showLoadingOverlay ? (
          <View style={styles.attachOverlay} pointerEvents="none" testID="terminal-attach-loading">
            <LoadingSpinner size="small" color={theme.colors.foregroundMuted} />
          </View>
        ) : null}

        {showFloatingCopyAction ? (
          <View pointerEvents="box-none" style={styles.floatingCopyContainer}>
            <TerminalFloatingCopyAction hasSelection={hasSelection} onCopy={handleTerminalCopy} />
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
          <View style={styles.keyboardRows}>
            {TERMINAL_VIRTUAL_KEYBOARD_ROWS.map((row) => (
              <View
                key={row.map(getTerminalVirtualKeyboardControlId).join(":")}
                style={styles.keyboardRow}
              >
                {row.map(renderVirtualKeyboardControl)}
              </View>
            ))}
          </View>
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
  floatingCopyContainer: {
    position: "absolute",
    right: theme.spacing[3],
    bottom: theme.spacing[12],
    zIndex: 2,
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
    fontSize: theme.fontSize.sm,
  },
  keyboardContainer: {
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
    backgroundColor: theme.colors.surface0,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[2],
  },
  keyboardRows: {
    gap: theme.spacing[1],
  },
  keyboardRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  keyButton: {
    flex: 1,
    minWidth: 0,
    height: 34,
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: theme.spacing[1],
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
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
    textAlign: "center",
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
    fontSize: theme.fontSize.base,
    textAlign: "center",
  },
}));

const TERMINAL_EMULATOR_DOM_PROPS = {
  style: { flex: 1 },
  matchContents: false,
  scrollEnabled: true,
  nestedScrollEnabled: true,
  overScrollMode: "never" as const,
  bounces: false,
  automaticallyAdjustContentInsets: false,
  contentInsetAdjustmentBehavior: "never" as const,
};

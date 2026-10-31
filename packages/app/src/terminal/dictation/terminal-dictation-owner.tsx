import { useEffect, useRef, type MutableRefObject } from "react";
import { useTranslation } from "react-i18next";
import { useToast } from "@/contexts/toast-context";
import { useDictation } from "@/hooks/use-dictation";
import { useKeyboardActionHandler } from "@/hooks/use-keyboard-action-handler";
import { useStableEvent } from "@/hooks/use-stable-event";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import {
  claimTerminalRecording,
  clearTerminalDictationState,
  getTerminalRecordingOwnerId,
  publishTerminalDictationState,
  releaseTerminalRecording,
  useTerminalRecordingOwnerId,
  type TerminalDictationActions,
} from "@/terminal/input-sink";
import { formatTerminalTranscript } from "./format-terminal-transcript";
import {
  resolveTerminalDictationAvailability,
  type TerminalDictationAvailability,
} from "./terminal-dictation-availability";
import { resolveTerminalDictationLifecycle } from "./terminal-dictation-lifecycle";

export type TerminalDictationOwnerActions = Omit<TerminalDictationActions, "ownerId">;

interface TerminalDictationOwnerProps {
  ownerId: string;
  serverId: string;
  terminalId: string;
  /** The pane's terminal is the one on screen: its tab is selected and its workspace focused. */
  isPresented: boolean;
  pasteText: (text: string) => void;
  focus: () => void;
  /** Evaluated when the shortcut fires: true while DOM focus is inside this pane's terminal. */
  isKeyboardOwner: () => boolean;
  /** Where the owner hands its actions to the pane's input sink. */
  actionsRef: MutableRefObject<TerminalDictationOwnerActions | null>;
}

/**
 * Owns one terminal pane's dictation. Mounted inside the pane and keyed by its
 * terminal, so a transcript can only reach the pane that recorded it; the tab-bar
 * control and the key bar are views of the state it publishes. Renders nothing,
 * and lives apart from the pane so volume ticks re-render only this component.
 *
 * The recording ends, microphone and pending result included, when the pane
 * unmounts or changes terminal (remount through the key), when the terminal stops
 * being presented, and when another terminal starts recording.
 */
export function TerminalDictationOwner({
  ownerId,
  serverId,
  terminalId,
  isPresented,
  pasteText,
  focus,
  isKeyboardOwner,
  actionsRef,
}: TerminalDictationOwnerProps) {
  const { t } = useTranslation();
  const toast = useToast();
  const client = useHostRuntimeClient(serverId);
  const isConnected = useHostRuntimeIsConnected(serverId);
  const serverInfo = useSessionStore((state) => state.sessions[serverId]?.serverInfo ?? null);
  const recordingOwnerId = useTerminalRecordingOwnerId();
  const isPresentedRef = useRef(isPresented);
  isPresentedRef.current = isPresented;

  const handleTranscript = useStableEvent((text: string) => {
    // A result resolving in the same tick as a cancel: drop it unless this pane is
    // still on screen and still the recording terminal.
    if (!isPresentedRef.current || getTerminalRecordingOwnerId() !== ownerId) {
      return;
    }
    const formatted = formatTerminalTranscript(text);
    if (formatted !== null) {
      pasteText(formatted);
    }
    focus();
  });
  const handleError = useStableEvent((error: Error) => {
    toast.error(error.message);
  });

  const dictation = useDictation({
    client,
    onTranscript: handleTranscript,
    onError: handleError,
    enableDuration: true,
  });
  const statusRef = useRef(dictation.status);
  statusRef.current = dictation.status;

  const unavailableMessage = (
    availability: Exclude<TerminalDictationAvailability, { kind: "ready" }>,
  ) => {
    if (availability.kind === "disconnected") {
      return t("workspace.terminal.hostDisconnected");
    }
    if (availability.reason === "update-host") {
      return t("workspace.terminal.dictation.updateHost");
    }
    return availability.message ?? t("workspace.terminal.dictation.unavailable");
  };

  const toggle = useStableEvent(() => {
    if (!isPresentedRef.current) {
      return;
    }
    const status = statusRef.current;
    if (status === "recording" || status === "paused") {
      void dictation.confirmDictation();
      return;
    }
    if (status !== "idle") {
      return;
    }
    const availability = resolveTerminalDictationAvailability({ serverInfo, isConnected });
    if (availability.kind !== "ready") {
      toast.error(unavailableMessage(availability));
      return;
    }
    claimTerminalRecording(ownerId);
    void dictation.startDictation();
  });
  const cancel = useStableEvent(() => {
    void dictation.cancelDictation();
    focus();
  });
  const confirm = useStableEvent(() => {
    void dictation.confirmDictation();
  });
  const retry = useStableEvent(() => {
    void dictation.retryFailedDictation();
  });
  const discard = useStableEvent(() => {
    dictation.discardFailedDictation();
    focus();
  });

  useEffect(() => {
    const actions: TerminalDictationOwnerActions = { toggle, cancel, confirm, retry, discard };
    actionsRef.current = actions;
    return () => {
      if (actionsRef.current === actions) {
        actionsRef.current = null;
      }
    };
  }, [actionsRef, cancel, confirm, discard, retry, toggle]);

  // Only a change of presentation or recording owner ends the recording, so the
  // status is read at that moment instead of re-running on every status change.
  const applyLifecycle = useStableEvent(
    (input: { isPresented: boolean; isRecordingOwner: boolean }) => {
      const decision = resolveTerminalDictationLifecycle({ ...input, status: statusRef.current });
      if (decision === "cancel") {
        void dictation.cancelDictation();
      } else if (decision === "discard") {
        dictation.discardFailedDictation();
      }
    },
  );
  useEffect(() => {
    applyLifecycle({ isPresented, isRecordingOwner: recordingOwnerId === ownerId });
  }, [applyLifecycle, isPresented, ownerId, recordingOwnerId]);

  useEffect(() => {
    return () => releaseTerminalRecording(ownerId);
  }, [ownerId]);

  const { status, isRecording, isProcessing, error, duration, volume } = dictation;
  useEffect(() => {
    publishTerminalDictationState(ownerId, {
      status,
      isRecording,
      isProcessing,
      error,
      duration,
      volume,
    });
  }, [duration, error, isProcessing, isRecording, ownerId, status, volume]);
  useEffect(() => () => clearTerminalDictationState(ownerId), [ownerId]);

  useKeyboardActionHandler({
    handlerId: `terminal-dictation:${serverId}:${terminalId}:${ownerId}`,
    actions: ["terminal.dictation-toggle"],
    enabled: isPresented,
    priority: 0,
    isActive: isKeyboardOwner,
    handle: () => {
      toggle();
      return true;
    },
  });

  return null;
}

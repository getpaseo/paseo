import { useEffect } from "react";
import { create } from "zustand";
import type { SelectedFile } from "@/attachments/selected-file";
import type { DictationStatus } from "@/hooks/use-dictation";

/**
 * What a mounted terminal pane accepts from its controls. The tab-bar slot is a
 * sibling of the pane under three different hosts (split pane, fallback row,
 * explorer sidebar), so it finds the pane here by terminal identity instead of
 * through props. The key bar renders inside the pane and receives the pane's own
 * sink as a prop: when two panes show one terminal the registry holds only the
 * newer one, and each key bar must still act on its own pane.
 */
export interface TerminalInputSink {
  /** Pastes text the way the terminal's TUI expects it (bracketed when enabled). */
  pasteText(text: string): void;
  /** Delivers picked files: own paths when the host can read them, uploads otherwise. */
  deliverFiles(files: SelectedFile[]): void;
  /** Returns keyboard focus to the terminal. */
  focus(): void;
  /** Forwards to the pane's dictation owner; does nothing while no owner is mounted. */
  dictation: TerminalDictationActions;
}

export interface TerminalDictationActions {
  /** Identifies the pane's owner; its published state is under this id. */
  ownerId: string;
  /** Starts dictation, or confirms it while recording. */
  toggle(): void;
  cancel(): void;
  confirm(): void;
  retry(): void;
  discard(): void;
}

/** What a dictation owner publishes for its controls. */
export interface TerminalDictationState {
  status: DictationStatus;
  isRecording: boolean;
  isProcessing: boolean;
  error: string | null;
  duration: number;
  volume: number;
}

interface TerminalInputSinkState {
  sinks: Record<string, TerminalInputSink>;
  /** Keyed by owner id, apart from `sinks` so volume ticks never change a sink. */
  dictationStates: Record<string, TerminalDictationState>;
  /** The owner whose terminal is recording; one terminal records at a time. */
  recordingOwnerId: string | null;
}

const useTerminalInputSinkStore = create<TerminalInputSinkState>(() => ({
  sinks: {},
  dictationStates: {},
  recordingOwnerId: null,
}));

export function terminalInputSinkKey(serverId: string, terminalId: string): string {
  return `${serverId}:${terminalId}`;
}

/**
 * Registers `sink` under the terminal's key. The returned cleanup removes the
 * entry only while it is still this sink, so a retained pane that unmounts after
 * a newer pane registered the same terminal never removes the newer one.
 */
export function registerTerminalInputSink(
  serverId: string,
  terminalId: string,
  sink: TerminalInputSink,
): () => void {
  const key = terminalInputSinkKey(serverId, terminalId);
  useTerminalInputSinkStore.setState((state) => ({ sinks: { ...state.sinks, [key]: sink } }));
  return () => {
    useTerminalInputSinkStore.setState((state) => {
      if (state.sinks[key] !== sink) {
        return state;
      }
      const { [key]: _removed, ...sinks } = state.sinks;
      return { sinks };
    });
  };
}

export function getTerminalInputSink(
  serverId: string,
  terminalId: string,
): TerminalInputSink | null {
  return (
    useTerminalInputSinkStore.getState().sinks[terminalInputSinkKey(serverId, terminalId)] ?? null
  );
}

/** Registers the pane's sink while it is mounted. Pass a memoized sink. */
export function useRegisterTerminalInputSink(
  serverId: string,
  terminalId: string,
  sink: TerminalInputSink,
): void {
  useEffect(
    () => registerTerminalInputSink(serverId, terminalId, sink),
    [serverId, terminalId, sink],
  );
}

/** The mounted pane's sink for this terminal; re-renders only when that entry changes. */
export function useTerminalInputSink(
  serverId: string,
  terminalId: string,
): TerminalInputSink | null {
  const key = terminalInputSinkKey(serverId, terminalId);
  return useTerminalInputSinkStore((state) => state.sinks[key] ?? null);
}

export function publishTerminalDictationState(
  ownerId: string,
  dictationState: TerminalDictationState,
): void {
  useTerminalInputSinkStore.setState((state) => ({
    dictationStates: { ...state.dictationStates, [ownerId]: dictationState },
  }));
}

export function clearTerminalDictationState(ownerId: string): void {
  useTerminalInputSinkStore.setState((state) => {
    if (!(ownerId in state.dictationStates)) {
      return state;
    }
    const { [ownerId]: _removed, ...dictationStates } = state.dictationStates;
    return { dictationStates };
  });
}

/** The owner's published state, or null while no owner with this id is mounted. */
export function useTerminalDictationState(ownerId: string): TerminalDictationState | null {
  return useTerminalInputSinkStore((state) => state.dictationStates[ownerId] ?? null);
}

/** Makes `ownerId` the recording terminal; the previous owner cancels itself. */
export function claimTerminalRecording(ownerId: string): void {
  useTerminalInputSinkStore.setState({ recordingOwnerId: ownerId });
}

/** Clears the recording owner only while it is still `ownerId`. */
export function releaseTerminalRecording(ownerId: string): void {
  useTerminalInputSinkStore.setState((state) =>
    state.recordingOwnerId === ownerId ? { recordingOwnerId: null } : state,
  );
}

export function getTerminalRecordingOwnerId(): string | null {
  return useTerminalInputSinkStore.getState().recordingOwnerId;
}

export function useTerminalRecordingOwnerId(): string | null {
  return useTerminalInputSinkStore((state) => state.recordingOwnerId);
}

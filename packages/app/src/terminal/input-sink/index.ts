import { useEffect } from "react";
import { create } from "zustand";
import type { SelectedFile } from "@/attachments/selected-file";

/**
 * What a mounted terminal pane accepts from controls rendered outside it: the
 * pane's tab-bar slot and its key bar. Those controls are siblings of the pane
 * under three different hosts (split pane, fallback row, explorer sidebar), so
 * they find the pane here by terminal identity instead of through props.
 */
export interface TerminalInputSink {
  /** Pastes text the way the terminal's TUI expects it (bracketed when enabled). */
  pasteText(text: string): void;
  /** Delivers picked files: own paths when the host can read them, uploads otherwise. */
  deliverFiles(files: SelectedFile[]): void;
  /** Returns keyboard focus to the terminal. */
  focus(): void;
}

interface TerminalInputSinkState {
  sinks: Record<string, TerminalInputSink>;
}

const useTerminalInputSinkStore = create<TerminalInputSinkState>(() => ({ sinks: {} }));

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

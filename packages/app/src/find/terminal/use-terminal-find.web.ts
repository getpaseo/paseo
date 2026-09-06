import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import type { TerminalEmulatorHandle } from "@/components/terminal-emulator-contract";
import { createTerminalFindEngine, type TerminalFindEngine } from "@/find/terminal/engine.web";
import { useFindSurface, type UseFindSurfaceResult } from "@/find/use-find-surface";
import type { TerminalFindResults } from "@/terminal/runtime/terminal-emulator-runtime";

export interface UseTerminalFindInput {
  /**
   * `isWeb && retained panel active`. Deliberately not gated on renderer readiness: an
   * unregistered surface lets Cmd+F through to xterm's textarea, which sends it to the
   * shell, and to the browser's own find. The bar opens against a null engine and
   * `useFindSurface` applies the query once the engine appears.
   */
  enabled: boolean;
  /**
   * Identifies the mounted emulator, or null while no renderer is ready. A changed key
   * rebuilds the engine, which is what re-applies an open query to a terminal the pane
   * just swapped in — the emulator remounts with a fresh addon and no decorations.
   */
  engineKey: string | null;
  emulatorRef: RefObject<TerminalEmulatorHandle | null>;
  /** The pane container that holds both the emulator and the find bar. */
  getRoot: () => HTMLElement | null;
}

export interface UseTerminalFindResult {
  find: UseFindSurfaceResult;
  /** Wire to `<TerminalEmulator onFindResultsChange>`. */
  onFindResultsChange: (results: TerminalFindResults) => void;
  /** Wire to `<TerminalEmulator onFindBufferChange>`. */
  onFindBufferChange: () => void;
}

export function useTerminalFind({
  enabled,
  engineKey,
  emulatorRef,
  getRoot,
}: UseTerminalFindInput): UseTerminalFindResult {
  const [engine, setEngine] = useState<TerminalFindEngine | null>(null);
  const engineRef = useRef<TerminalFindEngine | null>(null);
  engineRef.current = engine;

  useEffect(() => {
    if (!enabled || engineKey === null) {
      return;
    }
    const created = createTerminalFindEngine({ getEmulator: () => emulatorRef.current });
    setEngine(created);
    return () => {
      created.dispose();
      setEngine(null);
    };
  }, [emulatorRef, enabled, engineKey]);

  // The emulator reports through props, which re-render; the engine is reached through a
  // ref so these callbacks keep one identity for the emulator's callback effect.
  const onFindResultsChange = useCallback((results: TerminalFindResults) => {
    engineRef.current?.reportResults(results);
  }, []);

  const onFindBufferChange = useCallback(() => {
    engineRef.current?.reapply();
  }, []);

  // xterm keeps its own selection; there is no DOM selection to prefill from.
  const getSelectionText = useCallback(
    () => emulatorRef.current?.getSelectionText() ?? "",
    [emulatorRef],
  );

  const find = useFindSurface({
    name: "terminal",
    engine,
    enabled,
    getRoot,
    getSelectionText,
  });

  return { find, onFindResultsChange, onFindBufferChange };
}

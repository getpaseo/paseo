import { useEffect, useRef } from "react";
import { useFileDropContext } from "./context";
import type { FileDropSink } from "./types";

interface UseFileDropOptions {
  /** When true, the zone hides the backdrop and rejects drops atomically (e.g. while submitting). */
  disabled?: boolean;
}

/**
 * Receive files dropped onto the surrounding FileDropZone. The sink is read through
 * a ref, so passing a fresh object every render neither re-registers nor re-renders.
 * No-ops when rendered without a FileDropZone ancestor.
 */
export function useFileDrop(sink: FileDropSink, options?: UseFileDropOptions): void {
  const ctx = useFileDropContext();
  const sinkRef = useRef(sink);
  sinkRef.current = sink;
  const disabled = options?.disabled ?? false;

  const registerSink = ctx?.registerSink;
  useEffect(() => {
    if (!registerSink) return;
    return registerSink(() => sinkRef.current);
  }, [registerSink]);

  const suppressed = ctx?.suppressed;
  useEffect(() => {
    if (!suppressed) return;
    suppressed.value = disabled;
    return () => {
      suppressed.value = false;
    };
  }, [suppressed, disabled]);
}

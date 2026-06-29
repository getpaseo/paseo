import { useEffect, useRef } from "react";
import { useFileDropContext } from "./context";
import type { FileDropSink } from "./types";

/**
 * Receive files dropped onto the surrounding FileDropZone. The sink is read through
 * a ref, so passing a fresh object every render neither re-registers nor re-renders.
 * No-ops when rendered without a FileDropZone ancestor.
 */
export function useFileDrop(sink: FileDropSink): void {
  const ctx = useFileDropContext();
  const sinkRef = useRef(sink);
  sinkRef.current = sink;

  const registerSink = ctx?.registerSink;
  useEffect(() => {
    if (!registerSink) return;
    return registerSink(() => sinkRef.current);
  }, [registerSink]);
}

import { createContext, useContext } from "react";
import type { SharedValue } from "react-native-reanimated";
import type { FileDropSink } from "./types";

export interface FileDropContextValue {
  /** Drag-active flag, driven on the UI thread so toggling it triggers no React render. */
  isDragging: SharedValue<boolean>;
  /** Active sink can't accept right now (e.g. composer submitting): hide backdrop and reject drops. */
  suppressed: SharedValue<boolean>;
  /** Whether a consumer is currently registered — no consumer (e.g. archived agent), no backdrop. */
  hasSink: SharedValue<boolean>;
  /** Register the active sink. Pass a getter so the zone always reads the latest handlers. */
  registerSink: (getSink: () => FileDropSink | null) => () => void;
}

export const FileDropContext = createContext<FileDropContextValue | null>(null);

export function useFileDropContext(): FileDropContextValue | null {
  return useContext(FileDropContext);
}

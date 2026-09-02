import { useEffect, useState, useSyncExternalStore } from "react";
import type { LiveFileSnapshot } from "../live-file/model";
import {
  createFilePanePreview,
  FilePreviewLifecycleModel,
  type FilePreviewLifecycleSnapshot,
} from "./model";

/** Bridges the raw-file owner to the preview preparation owner. */
export function useFilePreview(input: {
  targetKey: string | null;
  liveFileSnapshot: LiveFileSnapshot;
  preparationRevision?: number;
}): FilePreviewLifecycleSnapshot {
  const [model] = useState(() => new FilePreviewLifecycleModel(createFilePanePreview));
  const snapshot = useSyncExternalStore(model.subscribe, model.getSnapshot, model.getSnapshot);
  const { targetKey, liveFileSnapshot, preparationRevision } = input;

  useEffect(() => {
    model.setSource({ targetKey, liveFileSnapshot, preparationRevision });
  }, [liveFileSnapshot, model, preparationRevision, targetKey]);

  return snapshot;
}

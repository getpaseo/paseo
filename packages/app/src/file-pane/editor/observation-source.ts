import { explorerFileFromReadResult } from "@/file-explorer/read-result";
import type { LiveFileObservation } from "../live-file/model";
import type { FileEditorObservation, FileObservationSource } from "./model";

export interface LiveObservationSource {
  subscribe(listener: () => void): () => void;
  getObservation(): LiveFileObservation | null;
  refresh(): void;
}

export function createFileObservationSource(
  liveFile: LiveObservationSource,
): FileObservationSource {
  let liveObservation: LiveFileObservation | null = null;
  let editorObservation: FileEditorObservation | null = null;
  return {
    subscribe: liveFile.subscribe,
    refresh: liveFile.refresh,
    getObservation() {
      const nextLiveObservation = liveFile.getObservation();
      if (nextLiveObservation === liveObservation) return editorObservation;
      liveObservation = nextLiveObservation;
      editorObservation = fileEditorObservation(nextLiveObservation);
      return editorObservation;
    },
  };
}

function fileEditorObservation(
  observation: LiveFileObservation | null,
): FileEditorObservation | null {
  if (!observation || observation.status !== "ready") return observation;
  const decodedFile = explorerFileFromReadResult(observation.file);
  if (decodedFile.kind !== "text" || decodedFile.content === undefined) {
    return {
      status: "error",
      cwd: observation.version.cwd,
      path: observation.version.path,
      error: "File is no longer text.",
    };
  }
  return {
    status: "ready",
    file: {
      content: decodedFile.content,
      hasBom: decodedFile.hasBom,
      version: observation.version,
    },
  };
}

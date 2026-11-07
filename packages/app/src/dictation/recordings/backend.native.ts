import * as FileSystem from "expo-file-system/legacy";
import type { DictationRecording, DictationRecordingBackend } from "./types";

const METADATA_SUFFIX = ".meta.json";
const AUDIO_SUFFIX = ".audio.json";

// Documents, not cache: the OS may purge the cache, and these exist to survive failures.
function recordingsDirectory(): string {
  const root = FileSystem.documentDirectory;
  if (!root) {
    throw new Error("Document storage is unavailable.");
  }
  return `${root}dictation-recordings/`;
}

async function ensureDirectory(): Promise<string> {
  const directory = recordingsDirectory();
  const info = await FileSystem.getInfoAsync(directory);
  if (!info.exists) {
    await FileSystem.makeDirectoryAsync(directory, { intermediates: true });
  }
  return directory;
}

export function createDictationRecordingBackend(): DictationRecordingBackend {
  return {
    async listMetadata() {
      const directory = await ensureDirectory();
      const names = await FileSystem.readDirectoryAsync(directory);
      const recordings = await Promise.all(
        names
          .filter((name) => name.endsWith(METADATA_SUFFIX))
          .map(async (name) => {
            try {
              const raw = await FileSystem.readAsStringAsync(`${directory}${name}`);
              return JSON.parse(raw) as DictationRecording;
            } catch {
              return null;
            }
          }),
      );
      return recordings.filter((recording): recording is DictationRecording => !!recording);
    },
    async writeMetadata(recording) {
      const directory = await ensureDirectory();
      await FileSystem.writeAsStringAsync(
        `${directory}${recording.id}${METADATA_SUFFIX}`,
        JSON.stringify(recording),
      );
    },
    async writeSegments(id, segments) {
      const directory = await ensureDirectory();
      await FileSystem.writeAsStringAsync(
        `${directory}${id}${AUDIO_SUFFIX}`,
        JSON.stringify(segments),
      );
    },
    async readSegments(id) {
      const path = `${await ensureDirectory()}${id}${AUDIO_SUFFIX}`;
      const info = await FileSystem.getInfoAsync(path);
      if (!info.exists) {
        return null;
      }
      return JSON.parse(await FileSystem.readAsStringAsync(path)) as string[];
    },
    async remove(id) {
      const directory = await ensureDirectory();
      await Promise.all([
        FileSystem.deleteAsync(`${directory}${id}${METADATA_SUFFIX}`, { idempotent: true }),
        FileSystem.deleteAsync(`${directory}${id}${AUDIO_SUFFIX}`, { idempotent: true }),
      ]);
    },
  };
}

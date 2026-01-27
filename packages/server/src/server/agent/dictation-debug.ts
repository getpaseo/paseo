import type pino from "pino";
import { mkdir, writeFile } from "fs/promises";
import { join } from "path";
import { inferAudioExtension, sanitizeForFilename } from "./audio-utils.js";
import { resolveRecordingsDebugDir } from "./recordings-debug.js";

let announcedDir: string | null = null;

export interface DictationDebugAudioMetadata {
  sessionId: string;
  dictationId: string;
  format: string;
}

export async function maybePersistDictationDebugAudio(
  audio: Buffer,
  metadata: DictationDebugAudioMetadata,
  logger: pino.Logger
): Promise<string | null> {
  const debugDir = resolveRecordingsDebugDir("DICTATION_DEBUG_AUDIO_DIR");
  if (!debugDir) {
    return null;
  }

  if (announcedDir !== debugDir) {
    logger.info({ debugDir }, "Dictation audio capture enabled");
    announcedDir = debugDir;
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const folder = join(debugDir, sanitizeForFilename(metadata.sessionId, "session"));
  await mkdir(folder, { recursive: true });

  const parts = [timestamp, sanitizeForFilename(metadata.dictationId, "dictation")];
  const ext = inferAudioExtension(metadata.format);
  const filePath = join(folder, `${parts.join("_")}.${ext}`);
  await writeFile(filePath, audio);
  return filePath;
}

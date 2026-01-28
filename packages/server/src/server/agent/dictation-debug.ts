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

export interface DictationDebugChunkWriter {
  folder: string;
  writeChunk: (seq: number, pcm16: Buffer) => Promise<void>;
}

export function createDictationDebugChunkWriter(
  metadata: Pick<DictationDebugAudioMetadata, "sessionId" | "dictationId">,
  logger: pino.Logger
): DictationDebugChunkWriter | null {
  const debugDir = resolveRecordingsDebugDir("DICTATION_DEBUG_AUDIO_DIR");
  if (!debugDir) {
    return null;
  }

  if (announcedDir !== debugDir) {
    logger.info({ debugDir }, "Dictation audio capture enabled");
    announcedDir = debugDir;
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const folder = join(
    debugDir,
    sanitizeForFilename(metadata.sessionId, "session"),
    `${timestamp}_${sanitizeForFilename(metadata.dictationId, "dictation")}`
  );

  let folderCreated = false;

  return {
    folder,
    writeChunk: async (seq: number, pcm16: Buffer) => {
      if (!folderCreated) {
        await mkdir(folder, { recursive: true });
        folderCreated = true;
      }
      const paddedSeq = String(seq).padStart(6, "0");
      const filePath = join(folder, `chunk_${paddedSeq}.pcm`);
      await writeFile(filePath, pcm16);
    },
  };
}

export async function maybePersistDictationDebugAudio(
  audio: Buffer,
  metadata: DictationDebugAudioMetadata,
  logger: pino.Logger,
  chunkWriterFolder?: string | null
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
  const folder = chunkWriterFolder ?? join(debugDir, sanitizeForFilename(metadata.sessionId, "session"));
  await mkdir(folder, { recursive: true });

  const filename = chunkWriterFolder
    ? `combined.${inferAudioExtension(metadata.format)}`
    : `${timestamp}_${sanitizeForFilename(metadata.dictationId, "dictation")}.${inferAudioExtension(metadata.format)}`;
  const filePath = join(folder, filename);
  await writeFile(filePath, audio);
  return filePath;
}

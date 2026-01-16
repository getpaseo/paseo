import type pino from "pino";
import { mkdir, writeFile } from "fs/promises";
import { join, resolve } from "path";
import { inferAudioExtension, sanitizeForFilename } from "./audio-utils.js";

const debugDir = process.env.STT_DEBUG_AUDIO_DIR
  ? resolve(process.env.STT_DEBUG_AUDIO_DIR)
  : null;
let announced = false;

export interface DebugAudioMetadata {
  sessionId: string;
  agentId?: string;
  requestId?: string;
  label?: string;
  format: string;
}

export async function maybePersistDebugAudio(
  audio: Buffer,
  metadata: DebugAudioMetadata,
  logger: pino.Logger
): Promise<string | null> {
  if (!debugDir) {
    return null;
  }

  if (!announced) {
    logger.info({ debugDir }, "Raw audio capture enabled");
    announced = true;
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const folder = join(debugDir, sanitizeForFilename(metadata.sessionId, "session"));
  await mkdir(folder, { recursive: true });

  const parts = [timestamp];
  if (metadata.agentId) {
    parts.push(sanitizeForFilename(metadata.agentId, "agent"));
  }
  if (metadata.label) {
    parts.push(sanitizeForFilename(metadata.label, "source"));
  }
  if (metadata.requestId) {
    parts.push(sanitizeForFilename(metadata.requestId, "request"));
  }

  const ext = inferAudioExtension(metadata.format);
  const filePath = join(folder, `${parts.join("_")}.${ext}`);
  await writeFile(filePath, audio);
  return filePath;
}

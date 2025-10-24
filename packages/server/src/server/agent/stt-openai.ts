import OpenAI from "openai";
import { writeFile, unlink } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { v4 as uuidv4 } from "uuid";

export interface STTConfig {
  apiKey: string;
  model?: "whisper-1";
  confidenceThreshold?: number; // Default: -3.0
}

export interface LogprobToken {
  token: string;
  logprob: number;
  bytes?: number[];
}

export interface TranscriptionResult {
  text: string;
  language?: string;
  duration?: number;
  logprobs?: LogprobToken[];
  avgLogprob?: number;
  isLowConfidence?: boolean;
}

let openaiClient: OpenAI | null = null;
let config: STTConfig | null = null;

export function initializeSTT(sttConfig: STTConfig): void {
  config = sttConfig;
  openaiClient = new OpenAI({
    apiKey: sttConfig.apiKey,
  });
  console.log("✓ STT (OpenAI Whisper) initialized");
}

export async function transcribeAudio(
  audioBuffer: Buffer,
  format: string
): Promise<TranscriptionResult> {
  if (!openaiClient || !config) {
    throw new Error("STT not initialized. Call initializeSTT() first.");
  }

  const startTime = Date.now();
  let tempFilePath: string | null = null;

  try {
    // Map format to file extension
    const ext = getFileExtension(format);

    // Write audio buffer to temporary file
    // OpenAI API requires file upload, not raw buffer
    tempFilePath = join(tmpdir(), `audio-${uuidv4()}.${ext}`);
    await writeFile(tempFilePath, audioBuffer);

    console.log(
      `[STT] Transcribing audio file: ${tempFilePath} (${audioBuffer.length} bytes)`
    );

    // Call OpenAI Whisper API
    const response = await openaiClient.audio.transcriptions.create({
      file: await import("fs").then((fs) => fs.createReadStream(tempFilePath!)),
      language: "en",
      model: config.model ?? "gpt-4o-transcribe",
      include: ["logprobs"],
      response_format: "json", // Get language and duration info
    });

    const duration = Date.now() - startTime;

    // Get confidence threshold (default: -3.0)
    const confidenceThreshold = config.confidenceThreshold ?? -3.0;

    // Analyze logprobs if available
    let avgLogprob: number | undefined;
    let isLowConfidence = false;
    const logprobs = response.logprobs as LogprobToken[] | undefined;

    if (logprobs && logprobs.length > 0) {
      // Calculate average logprob
      const totalLogprob = logprobs.reduce(
        (sum, token) => sum + token.logprob,
        0
      );
      avgLogprob = totalLogprob / logprobs.length;

      // Check if transcription is low confidence
      isLowConfidence = avgLogprob < confidenceThreshold;

      if (isLowConfidence) {
        console.log(
          `[STT] Low confidence transcription detected (avg: ${avgLogprob.toFixed(
            2
          )}, threshold: ${confidenceThreshold}): "${response.text}"`
        );
        console.log(
          `[STT] Token logprobs:`,
          logprobs.map((t) => `${t.token}:${t.logprob.toFixed(2)}`).join(", ")
        );
      }
    }

    console.log(
      `[STT] Transcription complete in ${duration}ms: "${response.text}"${
        avgLogprob !== undefined
          ? ` (avg logprob: ${avgLogprob.toFixed(2)})`
          : ""
      }`
    );

    return {
      text: response.text,
      duration: duration,
      logprobs: logprobs,
      avgLogprob: avgLogprob,
      isLowConfidence: isLowConfidence,
    };
  } catch (error: any) {
    console.error("[STT] Transcription error:", error);
    throw new Error(`STT transcription failed: ${error.message}`);
  } finally {
    // Clean up temporary file
    if (tempFilePath) {
      try {
        await unlink(tempFilePath);
      } catch (cleanupError) {
        console.warn(`[STT] Failed to clean up temp file: ${tempFilePath}`);
      }
    }
  }
}

function getFileExtension(format: string): string {
  // Map mime types or format strings to file extensions
  const formatLower = format.toLowerCase();

  if (formatLower.includes("webm")) return "webm";
  if (formatLower.includes("ogg")) return "ogg";
  if (formatLower.includes("mp3")) return "mp3";
  if (formatLower.includes("wav")) return "wav";
  if (formatLower.includes("m4a")) return "m4a";
  if (formatLower.includes("mp4")) return "mp4";
  if (formatLower.includes("flac")) return "flac";

  // Default to webm (common browser format)
  return "webm";
}

export function isSTTInitialized(): boolean {
  return openaiClient !== null && config !== null;
}

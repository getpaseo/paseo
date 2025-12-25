import OpenAI from "openai";
import { writeFile, unlink } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { v4 } from "uuid";
import { inferAudioExtension } from "./audio-utils.js";

export interface STTConfig {
  apiKey: string;
  model?: "whisper-1" | "gpt-4o-transcribe" | "gpt-4o-mini-transcribe" | (string & {});
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

function isObject(value: unknown): value is { [key: string]: unknown } {
  return typeof value === "object" && value !== null;
}

function isLogprobToken(value: unknown): value is LogprobToken {
  if (!isObject(value)) {
    return false;
  }
  if (typeof value.token !== "string") {
    return false;
  }
  if (typeof value.logprob !== "number") {
    return false;
  }
  if (value.bytes === undefined) {
    return true;
  }
  return Array.isArray(value.bytes) && value.bytes.every((entry) => typeof entry === "number");
}

function isLogprobTokenArray(value: unknown): value is LogprobToken[] {
  return Array.isArray(value) && value.every((entry) => isLogprobToken(entry));
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
    const ext = inferAudioExtension(format);

    // Write audio buffer to temporary file
    // OpenAI API requires file upload, not raw buffer
    tempFilePath = join(tmpdir(), `audio-${v4()}.${ext}`);
    await writeFile(tempFilePath, audioBuffer);

    console.log(
      `[STT] Transcribing audio file: ${tempFilePath} (${audioBuffer.length} bytes)`
    );

    // Call OpenAI Whisper API
    const modelToUse = config.model ?? "whisper-1";
    const supportsLogprobs =
      modelToUse === "gpt-4o-transcribe" || modelToUse === "gpt-4o-mini-transcribe";
    const includeLogprobs: ["logprobs"] = ["logprobs"];

    const response = await openaiClient.audio.transcriptions.create({
      file: await import("fs").then((fs) => fs.createReadStream(tempFilePath!)),
      language: "en",
      model: modelToUse,
      ...(supportsLogprobs ? { include: includeLogprobs } : {}),
      response_format: "json", // Get language and duration info
    });

    const duration = Date.now() - startTime;

    // Get confidence threshold (default: -3.0)
    const confidenceThreshold = config.confidenceThreshold ?? -3.0;

    // Analyze logprobs if available
    let avgLogprob: number | undefined;
    let isLowConfidence = false;
    const logprobs =
      supportsLogprobs &&
      isObject(response) &&
      isLogprobTokenArray(response.logprobs)
        ? response.logprobs
        : undefined;

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
      language:
        isObject(response) && typeof response.language === "string"
          ? response.language
          : undefined,
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
export function isSTTInitialized(): boolean {
  return openaiClient !== null && config !== null;
}

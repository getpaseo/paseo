import type pino from "pino";
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

export class OpenAISTT {
  private readonly openaiClient: OpenAI;
  private readonly config: STTConfig;
  private readonly logger: pino.Logger;

  constructor(sttConfig: STTConfig, parentLogger: pino.Logger) {
    this.config = sttConfig;
    this.logger = parentLogger.child({ module: "agent", provider: "openai", component: "stt" });
    this.openaiClient = new OpenAI({
      apiKey: sttConfig.apiKey,
    });
    this.logger.info({ model: sttConfig.model || "whisper-1" }, "STT (OpenAI Whisper) initialized");
  }

  public async transcribeAudio(audioBuffer: Buffer, format: string): Promise<TranscriptionResult> {
    const startTime = Date.now();
    let tempFilePath: string | null = null;

    try {
      const ext = inferAudioExtension(format);
      tempFilePath = join(tmpdir(), `audio-${v4()}.${ext}`);
      await writeFile(tempFilePath, audioBuffer);

      this.logger.debug(
        { tempFilePath, bytes: audioBuffer.length },
        "Transcribing audio file"
      );

      const modelToUse = this.config.model ?? "whisper-1";
      const supportsLogprobs =
        modelToUse === "gpt-4o-transcribe" || modelToUse === "gpt-4o-mini-transcribe";
      const includeLogprobs: ["logprobs"] = ["logprobs"];

      const response = await this.openaiClient.audio.transcriptions.create({
        file: await import("fs").then((fs) => fs.createReadStream(tempFilePath!)),
        language: "en",
        model: modelToUse,
        ...(supportsLogprobs ? { include: includeLogprobs } : {}),
        response_format: "json",
      });

      const duration = Date.now() - startTime;
      const confidenceThreshold = this.config.confidenceThreshold ?? -3.0;

      let avgLogprob: number | undefined;
      let isLowConfidence = false;
      const logprobs =
        supportsLogprobs &&
        isObject(response) &&
        isLogprobTokenArray(response.logprobs)
          ? response.logprobs
          : undefined;

      if (logprobs && logprobs.length > 0) {
        const totalLogprob = logprobs.reduce((sum, token) => sum + token.logprob, 0);
        avgLogprob = totalLogprob / logprobs.length;
        isLowConfidence = avgLogprob < confidenceThreshold;

        if (isLowConfidence) {
          this.logger.debug(
            {
              avgLogprob,
              threshold: confidenceThreshold,
              text: response.text,
              tokenLogprobs: logprobs.map((t) => `${t.token}:${t.logprob.toFixed(2)}`).join(", "),
            },
            "Low confidence transcription detected"
          );
        }
      }

      this.logger.debug({ duration, text: response.text, avgLogprob }, "Transcription complete");

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
      this.logger.error({ err: error }, "Transcription error");
      throw new Error(`STT transcription failed: ${error.message}`);
    } finally {
      if (tempFilePath) {
        try {
          await unlink(tempFilePath);
        } catch (cleanupError) {
          this.logger.warn({ tempFilePath }, "Failed to clean up temp file");
        }
      }
    }
  }
}

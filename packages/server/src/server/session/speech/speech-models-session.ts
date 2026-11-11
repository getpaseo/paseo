import type { LocalSpeechModel } from "@getpaseo/protocol/speech/rpc-schemas";

import type { SessionInboundMessage, SessionOutboundMessage } from "../../messages.js";
import { LocalSpeechModelIdSchema } from "../../speech/providers/local/models.js";
import type { LocalSpeechModelStatus, SpeechService } from "../../speech/speech-runtime.js";

type SpeechModelsRuntime = Pick<
  SpeechService,
  "listLocalModels" | "downloadLocalModel" | "deleteLocalModel"
>;

export interface SpeechModelsSessionOptions {
  emit(message: SessionOutboundMessage): void;
  // Absent when the daemon runs without speech.
  runtime?: SpeechModelsRuntime | null;
}

export class SpeechModelsSession {
  constructor(private readonly options: SpeechModelsSessionOptions) {}

  // Handles the speech.local_models.* requests; returns undefined for any other message.
  dispatch(msg: SessionInboundMessage): Promise<void> | undefined {
    switch (msg.type) {
      case "speech.local_models.list.request":
        return this.handleList(msg);
      case "speech.local_models.download.request":
        this.handleDownload(msg);
        return Promise.resolve();
      case "speech.local_models.delete.request":
        return this.handleDelete(msg);
      default:
        return undefined;
    }
  }

  private async handleList(
    msg: Extract<SessionInboundMessage, { type: "speech.local_models.list.request" }>,
  ): Promise<void> {
    try {
      const models = await this.requireRuntime().listLocalModels();
      this.options.emit({
        type: "speech.local_models.list.response",
        payload: { requestId: msg.requestId, models: models.map(toWireModel), error: null },
      });
    } catch (error) {
      this.options.emit({
        type: "speech.local_models.list.response",
        payload: { requestId: msg.requestId, models: [], error: describeError(error) },
      });
    }
  }

  private handleDownload(
    msg: Extract<SessionInboundMessage, { type: "speech.local_models.download.request" }>,
  ): void {
    try {
      this.requireRuntime().downloadLocalModel(parseModelId(msg.modelId));
      this.options.emit({
        type: "speech.local_models.download.response",
        payload: { requestId: msg.requestId, error: null },
      });
    } catch (error) {
      this.options.emit({
        type: "speech.local_models.download.response",
        payload: { requestId: msg.requestId, error: describeError(error) },
      });
    }
  }

  private async handleDelete(
    msg: Extract<SessionInboundMessage, { type: "speech.local_models.delete.request" }>,
  ): Promise<void> {
    try {
      await this.requireRuntime().deleteLocalModel(parseModelId(msg.modelId));
      this.options.emit({
        type: "speech.local_models.delete.response",
        payload: { requestId: msg.requestId, error: null },
      });
    } catch (error) {
      this.options.emit({
        type: "speech.local_models.delete.response",
        payload: { requestId: msg.requestId, error: describeError(error) },
      });
    }
  }

  private requireRuntime(): SpeechModelsRuntime {
    if (!this.options.runtime) {
      throw new Error("Speech is unavailable on this daemon");
    }
    return this.options.runtime;
  }
}

function parseModelId(modelId: string) {
  const parsed = LocalSpeechModelIdSchema.safeParse(modelId);
  if (!parsed.success) {
    throw new Error(`Unknown local speech model: ${modelId}`);
  }
  return parsed.data;
}

function toWireModel(model: LocalSpeechModelStatus): LocalSpeechModel {
  const { spec, state, inUse } = model;
  return {
    id: spec.id,
    kind: spec.kind === "tts" ? "tts" : "stt",
    label: spec.label,
    description: spec.description,
    languages: [...spec.languages],
    downloadSizeBytes: spec.downloadSizeBytes,
    isDefault: spec.defaultFor !== undefined,
    inUse,
    status: state.status,
    ...(state.status === "downloading"
      ? { receivedBytes: state.receivedBytes, totalBytes: state.totalBytes }
      : {}),
    ...(state.status === "failed" ? { error: state.error } : {}),
  };
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

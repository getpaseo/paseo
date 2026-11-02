import { describe, expect, test } from "vitest";

import type { SessionOutboundMessage } from "../../messages.js";
import {
  listLocalSpeechModels,
  type LocalSpeechModelId,
} from "../../speech/providers/local/models.js";
import {
  LocalSpeechModelInUseError,
  type LocalSpeechModelStatus,
} from "../../speech/speech-runtime.js";
import { SpeechModelsSession } from "./speech-models-session.js";

const [firstModel] = listLocalSpeechModels();

function createSession(models: LocalSpeechModelStatus[], inUse: LocalSpeechModelId[] = []) {
  const emitted: SessionOutboundMessage[] = [];
  const downloads: LocalSpeechModelId[] = [];
  const session = new SpeechModelsSession({
    emit: (message) => emitted.push(message),
    runtime: {
      listLocalModels: async () => models,
      downloadLocalModel: (modelId) => {
        downloads.push(modelId);
      },
      deleteLocalModel: async (modelId) => {
        if (inUse.includes(modelId)) throw new LocalSpeechModelInUseError(modelId);
      },
    },
  });
  return { session, emitted, downloads };
}

describe("SpeechModelsSession", () => {
  test("lists catalog details and download progress before anything is installed", async () => {
    const { session, emitted } = createSession([
      {
        spec: firstModel,
        state: { status: "downloading", receivedBytes: 10, totalBytes: 40 },
        inUse: true,
      },
    ]);

    await session.dispatch({ type: "speech.local_models.list.request", requestId: "r1" });

    expect(emitted).toEqual([
      {
        type: "speech.local_models.list.response",
        payload: {
          requestId: "r1",
          error: null,
          models: [
            {
              id: firstModel.id,
              kind: "stt",
              label: firstModel.label,
              description: firstModel.description,
              languages: [...firstModel.languages],
              downloadSizeBytes: firstModel.downloadSizeBytes,
              isDefault: true,
              inUse: true,
              status: "downloading",
              receivedBytes: 10,
              totalBytes: 40,
            },
          ],
        },
      },
    ]);
  });

  test("rejects a model id outside the catalog without starting a download", () => {
    const { session, emitted, downloads } = createSession([]);

    void session.dispatch({
      type: "speech.local_models.download.request",
      requestId: "r2",
      modelId: "../../etc",
    });

    expect(downloads).toEqual([]);
    expect(emitted).toEqual([
      {
        type: "speech.local_models.download.response",
        payload: { requestId: "r2", error: "Unknown local speech model: ../../etc" },
      },
    ]);
  });

  test("reports why an in-use model cannot be deleted", async () => {
    const { session, emitted } = createSession([], [firstModel.id]);

    await session.dispatch({
      type: "speech.local_models.delete.request",
      requestId: "r3",
      modelId: firstModel.id,
    });

    expect(emitted).toEqual([
      {
        type: "speech.local_models.delete.response",
        payload: { requestId: "r3", error: new LocalSpeechModelInUseError(firstModel.id).message },
      },
    ]);
  });
});

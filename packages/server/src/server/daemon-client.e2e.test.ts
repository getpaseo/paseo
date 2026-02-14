import { describe, test, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";

import {
  createDaemonTestContext,
  type DaemonTestContext,
  DaemonClient,
} from "./test-utils/index.js";
import { getFullAccessConfig, getAskModeConfig } from "./daemon-e2e/agent-configs.js";
import { parseServerInfoStatusPayload } from "./messages.js";
import {
  chunkPcm16,
  parsePcm16MonoWav,
  wordSimilarity,
} from "./test-utils/dictation-e2e.js";

const openaiApiKey = process.env.OPENAI_API_KEY ?? null;

const localModelsDir =
  process.env.PASEO_LOCAL_MODELS_DIR ??
  path.join(homedir(), ".paseo", "models", "local-speech");

function hasSherpaZipformerModels(modelsDir: string): boolean {
  return (
    existsSync(
      path.join(
        modelsDir,
        "sherpa-onnx-streaming-zipformer-bilingual-zh-en-2023-02-20",
        "encoder-epoch-99-avg-1.onnx"
      )
    ) &&
    existsSync(
      path.join(
        modelsDir,
        "sherpa-onnx-streaming-zipformer-bilingual-zh-en-2023-02-20",
        "tokens.txt"
      )
    )
  );
}

function hasSherpaKittenModels(modelsDir: string): boolean {
  return (
    existsSync(path.join(modelsDir, "kitten-nano-en-v0_1-fp16", "model.fp16.onnx")) &&
    existsSync(path.join(modelsDir, "kitten-nano-en-v0_1-fp16", "voices.bin")) &&
    existsSync(path.join(modelsDir, "kitten-nano-en-v0_1-fp16", "tokens.txt"))
  );
}

const hasLocalSpeech = hasSherpaZipformerModels(localModelsDir) && hasSherpaKittenModels(localModelsDir);
const hasAnySpeech = hasLocalSpeech || Boolean(openaiApiKey);
const speechTest = hasAnySpeech ? test : test.skip;

function tmpCwd(): string {
  return mkdtempSync(path.join(tmpdir(), "daemon-client-"));
}

function waitForSignal<T>(
  timeoutMs: number,
  setup: (
    resolve: (value: T) => void,
    reject: (error: Error) => void
  ) => () => void
): Promise<T> {
  return new Promise((resolve, reject) => {
    let cleanup: (() => void) | null = null;
    const timeout = setTimeout(() => {
      if (cleanup) {
        cleanup();
      }
      reject(new Error(`Timeout waiting for event after ${timeoutMs}ms`));
    }, timeoutMs);

    cleanup = setup(
      (value) => {
        clearTimeout(timeout);
        cleanup?.();
        resolve(value);
      },
      (error) => {
        clearTimeout(timeout);
        cleanup?.();
        reject(error);
      }
    );
  });
}

describe("daemon client E2E", () => {
  let ctx: DaemonTestContext;

  beforeAll(async () => {
    const speechConfig =
      openaiApiKey
        ? {
            providers: {
              dictationStt: { provider: "openai" as const, explicit: true },
              voiceStt: { provider: "openai" as const, explicit: true },
              voiceTts: { provider: "openai" as const, explicit: true },
            },
          }
        : hasLocalSpeech
          ? {
              providers: {
                dictationStt: { provider: "local" as const, explicit: true },
                voiceStt: { provider: "local" as const, explicit: true },
                voiceTts: { provider: "local" as const, explicit: true },
              },
              local: {
                modelsDir: localModelsDir,
                models: {
                  dictationStt:
                    process.env.PASEO_DICTATION_LOCAL_STT_MODEL ??
                    "zipformer-bilingual-zh-en-2023-02-20",
                  voiceStt:
                    process.env.PASEO_VOICE_LOCAL_STT_MODEL ??
                    "zipformer-bilingual-zh-en-2023-02-20",
                  voiceTts:
                    process.env.PASEO_VOICE_LOCAL_TTS_MODEL ?? "kitten-nano-en-v0_1-fp16",
                },
              },
            }
          : undefined;

    ctx = await createDaemonTestContext({
      dictationFinalTimeoutMs: 5000,
      ...(openaiApiKey ? { openai: { apiKey: openaiApiKey } } : {}),
      ...(speechConfig ? { speech: speechConfig } : {}),
    });
  }, 60000);

  afterAll(async () => {
    await ctx.cleanup();
  }, 60000);

  test("handles session actions", async () => {
    expect(ctx.client.isConnected).toBe(true);

    const agents = await ctx.client.fetchAgents();
    expect(Array.isArray(agents)).toBe(true);

    const cwd = tmpCwd();
    const created = await ctx.client.createAgent({
      config: {
        ...getFullAccessConfig("codex"),
        cwd,
      },
    });

    await expect(ctx.client.setVoiceMode(true, created.id)).resolves.toMatchObject({
      enabled: true,
      agentId: created.id,
      accepted: true,
      error: null,
    });
    await expect(ctx.client.setVoiceMode(false)).resolves.toMatchObject({
      enabled: false,
      agentId: null,
      accepted: true,
      error: null,
    });

    await ctx.client.deleteAgent(randomUUID());
    rmSync(cwd, { recursive: true, force: true });
  }, 30000);

  test("emits server_info on websocket connect", async () => {
    const client = new DaemonClient({
      url: `ws://127.0.0.1:${ctx.daemon.port}/ws`,
    });

    const infoPromise = waitForSignal<{ serverId: string }>(5000, (resolve) => {
      const unsubscribe = client.on("status", (message) => {
        if (message.type !== "status") return;
        const payload = parseServerInfoStatusPayload(message.payload);
        if (!payload) return;
        resolve({ serverId: payload.serverId });
      });
      return unsubscribe;
    });

    await client.connect();
    const info = await infoPromise;
    expect(info.serverId.length).toBeGreaterThan(0);

    await client.close();
  }, 15000);

  test("emits disabled voice capability reasons on fresh daemon startup", async () => {
    const isolatedCtx = await createDaemonTestContext({
      speech: {
        providers: {
          dictationStt: { provider: "local", explicit: true, enabled: false },
          voiceStt: { provider: "local", explicit: true, enabled: false },
          voiceTts: { provider: "local", explicit: true, enabled: false },
        },
      },
    });

    const client = new DaemonClient({
      url: `ws://127.0.0.1:${isolatedCtx.daemon.port}/ws`,
    });

    try {
      const infoPromise = waitForSignal<{
        dictationEnabled: boolean;
        dictationReason: string;
        voiceEnabled: boolean;
        voiceReason: string;
      }>(5000, (resolve) => {
        const unsubscribe = client.on("status", (message) => {
          if (message.type !== "status") return;
          const payload = parseServerInfoStatusPayload(message.payload);
          if (!payload) return;
          const voice = payload.capabilities?.voice;
          if (!voice) return;
          resolve({
            dictationEnabled: voice.dictation.enabled,
            dictationReason: voice.dictation.reason,
            voiceEnabled: voice.voice.enabled,
            voiceReason: voice.voice.reason,
          });
        });
        return unsubscribe;
      });

      await client.connect();
      const info = await infoPromise;

      expect(info.dictationEnabled).toBe(false);
      expect(info.dictationReason).toBe("Dictation is disabled in daemon config.");
      expect(info.voiceEnabled).toBe(false);
      expect(info.voiceReason).toBe("Realtime voice is disabled in daemon config.");
    } finally {
      await client.close().catch(() => undefined);
      await isolatedCtx.cleanup();
    }
  }, 30000);

  test("handles concurrent filtered agent fetch requests", async () => {
    const firstRequestId = `fetch-${Date.now()}-a`;
    const secondRequestId = `fetch-${Date.now()}-b`;

    const [first, second] = await Promise.all([
      ctx.client.fetchAgents({
        requestId: firstRequestId,
        filter: { labels: { surface: "voice" } },
      }),
      ctx.client.fetchAgents({
        requestId: secondRequestId,
        filter: { labels: { surface: "voice" } },
      }),
    ]);

    expect(Array.isArray(first)).toBe(true);
    expect(Array.isArray(second)).toBe(true);
  }, 15000);

  test(
    "creates agent and exercises lifecycle",
    async () => {
      const cwd = tmpCwd();

      ctx.client.subscribeAgentUpdates();

      const agentUpdatePromise = waitForSignal(15000, (resolve) => {
        const unsubscribe = ctx.client.on("agent_update", (message) => {
          if (message.type !== "agent_update") {
            return;
          }
          if (message.payload.kind !== "upsert") {
            return;
          }
          resolve(message);
        });
        return unsubscribe;
      });

      const createRequestId = `create-${Date.now()}`;
      const createdStatusPromise = waitForSignal(15000, (resolve) => {
        const unsubscribe = ctx.client.on("status", (message) => {
          if (message.type !== "status") {
            return;
          }
          const payload = message.payload as {
            status?: string;
            agentId?: string;
            requestId?: string;
          };
          if (payload.status !== "agent_created") {
            return;
          }
          if (payload.requestId !== createRequestId) {
            return;
          }
          resolve(message);
        });
        return unsubscribe;
      });

      const agent = await ctx.client.createAgent({
        ...getFullAccessConfig("codex"),
        cwd,
        title: "Daemon Client V2",
        requestId: createRequestId,
      });

      expect(agent.id).toBeTruthy();
      expect(agent.status).toBe("idle");
      const fetched = await ctx.client.fetchAgent(agent.id);
      expect(fetched?.id).toBe(agent.id);

      const agentUpdate = await agentUpdatePromise;
      expect(agentUpdate.payload.agent.id).toBe(agent.id);
      const createdStatus = await createdStatusPromise;
      expect(
        (createdStatus.payload as { agentId?: string }).agentId
      ).toBe(agent.id);

      const failRequestId = `fail-${Date.now()}`;
      const failedStatusPromise = waitForSignal(15000, (resolve) => {
        const unsubscribe = ctx.client.on("status", (message) => {
          if (message.type !== "status") {
            return;
          }
          const payload = message.payload as {
            status?: string;
            requestId?: string;
          };
          if (payload.status !== "agent_create_failed") {
            return;
          }
          if (payload.requestId !== failRequestId) {
            return;
          }
          resolve(message);
        });
        return unsubscribe;
      });

      await expect(
        ctx.client.createAgent({
          ...getFullAccessConfig("codex"),
          cwd: "/this/path/does/not/exist/12345",
          title: "Should Fail",
          requestId: failRequestId,
        })
      ).rejects.toThrow("Working directory does not exist");
      await failedStatusPromise;

      let sawRefresh = false;
      const unsubscribe = ctx.client.subscribe((event) => {
        if (event.type === "status" && event.payload.status === "agent_refreshed") {
          sawRefresh = true;
        }
      });

      const statusPromise = waitForSignal(15000, (resolve) => {
        const unsubscribeStatus = ctx.client.on("status", (message) => {
          if (message.type !== "status") {
            return;
          }
          if (message.payload.status !== "agent_refreshed") {
            return;
          }
          if ((message.payload as { agentId?: string }).agentId !== agent.id) {
            return;
          }
          resolve(message);
        });
        return unsubscribeStatus;
      });

      const refreshResult = await ctx.client.refreshAgent(agent.id);
      unsubscribe();

      expect(refreshResult.status).toBe("agent_refreshed");
      expect(refreshResult.agentId).toBe(agent.id);
      expect(sawRefresh).toBe(true);
      const statusMessage = await statusPromise;
      expect((statusMessage.payload as { agentId?: string }).agentId).toBe(
        agent.id
      );

      const timelineResult = await ctx.client.fetchAgentTimeline(agent.id, {
        direction: "tail",
        limit: 1,
        projection: "projected",
      });
      expect(timelineResult.agentId).toBe(agent.id);

      const nextMode = agent.availableModes.find(
        (mode) => mode.id !== agent.currentModeId
      )?.id;

      if (nextMode) {
        await ctx.client.setAgentMode(agent.id, nextMode);
        const modeState = await ctx.client.waitForAgentUpsert(
          agent.id,
          (snapshot) => snapshot.currentModeId === nextMode,
          15000
        );
        expect(modeState.currentModeId).toBe(nextMode);
      } else {
        await ctx.client.setAgentMode(agent.id, agent.currentModeId ?? "auto");
      }

      let sawAssistantMessage = false;
      let sawRawAssistantMessage = false;
      const unsubscribeStream = ctx.client.subscribe((event) => {
        if (event.type !== "agent_stream" || event.agentId !== agent.id) {
          return;
        }
        if (
          event.event.type === "timeline" &&
          event.event.item.type === "assistant_message"
        ) {
          sawAssistantMessage = true;
        }
      });
      const unsubscribeRawStream = ctx.client.on("agent_stream", (message) => {
        if (message.type !== "agent_stream") {
          return;
        }
        if (message.payload.agentId !== agent.id) {
          return;
        }
        if (
          message.payload.event.type === "timeline" &&
          message.payload.event.item.type === "assistant_message"
        ) {
          sawRawAssistantMessage = true;
        }
      });
      await ctx.client.sendMessage(agent.id, "Say 'hello' and nothing else");
      const finalState = await ctx.client.waitForFinish(agent.id, 120000);
      unsubscribeStream();
      unsubscribeRawStream();
      expect(finalState.status).toBe("idle");
      expect(sawAssistantMessage).toBe(true);
      expect(sawRawAssistantMessage).toBe(true);

      await ctx.client.setVoiceMode(false);

      await ctx.client.abortRequest();
      await ctx.client.audioPlayed("audio-1");
      ctx.client.clearAgentAttention(agent.id);
      await ctx.client.cancelAgent(agent.id);

      const modelsRequestId = `models-${Date.now()}`;
      const modelsPromise = waitForSignal(30000, (resolve) => {
        const unsubscribeModels = ctx.client.on(
          "list_provider_models_response",
          (message) => {
            if (message.type !== "list_provider_models_response") {
              return;
            }
            if (message.payload.provider !== "codex") {
              return;
            }
            if (message.payload.requestId !== modelsRequestId) {
              return;
            }
            resolve(message);
          }
        );
        return unsubscribeModels;
      });

      const models = await ctx.client.listProviderModels("codex", {
        cwd,
        requestId: modelsRequestId,
      });
      const modelsMessage = await modelsPromise;
      expect(models.provider).toBe("codex");
      expect(models.fetchedAt).toBeTruthy();
      expect(models.requestId).toBe(modelsRequestId);
      expect(modelsMessage.payload.provider).toBe("codex");
      expect(modelsMessage.payload.requestId).toBe(modelsRequestId);

      const commandsRequestId = `commands-${Date.now()}`;
      const commandsResponsePromise = waitForSignal(15000, (resolve) => {
        const unsubscribeCommands = ctx.client.on(
          "list_commands_response",
          (message) => {
            if (message.type !== "list_commands_response") {
              return;
            }
            if (message.payload.agentId !== agent.id) {
              return;
            }
            if (message.payload.requestId !== commandsRequestId) {
              return;
            }
            resolve(message);
          }
        );
        return unsubscribeCommands;
      });

      const commands = await ctx.client.listCommands(agent.id, commandsRequestId);
      const commandsMessage = await commandsResponsePromise;
      expect(commands.agentId).toBe(agent.id);
      expect(Array.isArray(commands.commands)).toBe(true);
      expect(commands.requestId).toBe(commandsRequestId);
      expect(commandsMessage.payload.agentId).toBe(agent.id);
      expect(commandsMessage.payload.requestId).toBe(commandsRequestId);

      const persistence = finalState.final?.persistence;

      const agentDeletedPromise = waitForSignal(15000, (resolve) => {
        const unsubscribeDeleted = ctx.client.on("agent_deleted", (message) => {
          if (message.type !== "agent_deleted") {
            return;
          }
          if (message.payload.agentId !== agent.id) {
            return;
          }
          resolve(message);
        });
        return unsubscribeDeleted;
      });

      await ctx.client.deleteAgent(agent.id);
      const agentDeleted = await agentDeletedPromise;
      expect(agentDeleted.payload.agentId).toBe(agent.id);

      if (persistence) {
        const resumed = await ctx.client.resumeAgent(persistence);
        expect(resumed.id).toBeTruthy();
        expect(resumed.status).toBe("idle");
        await ctx.client.deleteAgent(resumed.id);
      }

      rmSync(cwd, { recursive: true, force: true });
    },
    300000
  );

  test(
    "handles permission flow",
    async () => {
      const cwd = tmpCwd();
      const filePath = path.join(cwd, "permission.txt");

      const agent = await ctx.client.createAgent({
        ...getAskModeConfig("codex"),
        cwd,
        title: "Permission Test",
      });

      const permissionRequestPromise = waitForSignal(60000, (resolve) => {
        const unsubscribe = ctx.client.on("agent_permission_request", (message) => {
          if (message.type !== "agent_permission_request") {
            return;
          }
          if (message.payload.agentId !== agent.id) {
            return;
          }
          resolve(message);
        });
        return unsubscribe;
      });

      const permissionResolvedPromise = waitForSignal(60000, (resolve) => {
        const unsubscribe = ctx.client.on("agent_permission_resolved", (message) => {
          if (message.type !== "agent_permission_resolved") {
            return;
          }
          if (message.payload.agentId !== agent.id) {
            return;
          }
          resolve(message);
        });
        return unsubscribe;
      });

      try {
        await ctx.client.sendMessage(
          agent.id,
          [
            "Use your shell tool to run: `printf \"ok\" > permission.txt`.",
            "This will require approval. Request permission and wait for approval before continuing.",
          ].join("\n")
        );

        const permissionState = await ctx.client.waitForFinish(agent.id, 60000);
        expect(permissionState.status).toBe("permission");
        expect(permissionState.final?.pendingPermissions?.length).toBeGreaterThan(0);
        const permission = permissionState.final!.pendingPermissions[0];
        expect(permission).toBeTruthy();
        expect(permission.id).toBeTruthy();

        const permissionRequest = await permissionRequestPromise;
        expect(permissionRequest.payload.agentId).toBe(agent.id);

        await ctx.client.respondToPermission(agent.id, permission.id, {
          behavior: "allow",
        });

        const permissionResolved = await permissionResolvedPromise;
        expect(permissionResolved.payload.requestId).toBe(permission.id);

        const finalState = await ctx.client.waitForFinish(agent.id, 120000);
        expect(finalState.status).toBe("idle");
        expect(existsSync(filePath)).toBe(true);
      } finally {
        // Prevent unhandled rejections if the test fails before promises resolve.
        await permissionRequestPromise.catch(() => {});
        await permissionResolvedPromise.catch(() => {});
        await ctx.client.deleteAgent(agent.id);
        rmSync(cwd, { recursive: true, force: true });
      }
    },
    180000
  );

  test(
    "exposes raw session events for reachable screens",
    async () => {
      const cwd = tmpCwd();
      const agent = await ctx.client.createAgent({
        ...getFullAccessConfig("codex"),
        cwd,
        title: "Raw Events Test",
      });

      await ctx.client.sendMessage(agent.id, "Say 'hello' and nothing else");
      await ctx.client.waitForFinish(agent.id, 120000);

      const timeline = await ctx.client.fetchAgentTimeline(agent.id, {
        direction: "tail",
        limit: 0,
        projection: "projected",
      });
      expect(timeline.entries.length).toBeGreaterThan(0);

      await ctx.client.deleteAgent(agent.id);
      rmSync(cwd, { recursive: true, force: true });
    },
    120000
  );

  speechTest(
    "does not process non-voice audio through the voice agent path",
    async () => {
      await ctx.client.setVoiceMode(false);

      let sawTranscriptLog = false;
      let sawAssistantChunk = false;
      let sawAssistantLog = false;

      const transcriptSeen = waitForSignal(60000, (resolve) => {
        const unsubscribeChunk = ctx.client.on("assistant_chunk", (message) => {
          if (message.type !== "assistant_chunk") {
            return;
          }
          if (message.payload.chunk.length > 0) {
            sawAssistantChunk = true;
          }
        });

        const unsubscribeActivity = ctx.client.on("activity_log", (message) => {
          if (message.type !== "activity_log") {
            return;
          }
          if (message.payload.type === "transcript") {
            sawTranscriptLog = true;
            resolve();
          }
          if (message.payload.type === "assistant") {
            sawAssistantLog = true;
          }
        });

        return () => {
          unsubscribeChunk();
          unsubscribeActivity();
        };
      });

      const fixturePath = path.resolve(
        process.cwd(),
        "..",
        "app",
        "e2e",
        "fixtures",
        "recording.wav"
      );
      const wav = await import("node:fs/promises").then((fs) => fs.readFile(fixturePath));
      await ctx.client.sendVoiceAudioChunk(wav.toString("base64"), "audio/wav", true);
      await transcriptSeen;
      await new Promise((resolve) => setTimeout(resolve, 1500));

      expect(sawTranscriptLog).toBe(true);
      expect(sawAssistantChunk).toBe(false);
      expect(sawAssistantLog).toBe(false);
    },
    90000
  );

  speechTest(
    "voice mode buffers audio until isLast and emits transcription_result",
    async () => {
      const voiceCwd = tmpCwd();
      const voiceAgent = await ctx.client.createAgent({
        config: {
          ...getFullAccessConfig("codex"),
          cwd: voiceCwd,
        },
      });
      await ctx.client.setVoiceMode(true, voiceAgent.id);

      const transcription = waitForSignal(30_000, (resolve) => {
        const unsubscribe = ctx.client.on("transcription_result", (message) => {
          if (message.type !== "transcription_result") {
            return;
          }
          resolve(message.payload);
        });
        return unsubscribe;
      });

      const errorSignal = waitForSignal(30_000, (resolve) => {
        const unsubscribeStatus = ctx.client.on("status", (message) => {
          if (message.type !== "status") {
            return;
          }
          if (message.payload.status !== "error") {
            return;
          }
          resolve(`status:error ${message.payload.message}`);
        });

        const unsubscribeLog = ctx.client.on("activity_log", (message) => {
          if (message.type !== "activity_log") {
            return;
          }
          if (message.payload.type !== "error") {
            return;
          }
          resolve(`activity_log:error ${message.payload.content}`);
        });

        return () => {
          unsubscribeStatus();
          unsubscribeLog();
        };
      });

      try {
        const fixturePath = path.resolve(
          process.cwd(),
          "..",
          "app",
          "e2e",
          "fixtures",
          "recording.wav"
        );
        const wav = await import("node:fs/promises").then((fs) => fs.readFile(fixturePath));
        const { sampleRate, pcm16 } = parsePcm16MonoWav(wav);
        expect(sampleRate).toBe(16000);
        const format = "audio/pcm;rate=16000;bits=16";

        const earlyTranscription = waitForSignal(1000, (resolve) => {
          const unsubscribe = ctx.client.on("transcription_result", (message) => {
            if (message.type !== "transcription_result") {
              return;
            }
            resolve(message.payload.text);
          });
          return unsubscribe;
        });

        const chunkBytes = 3200; // 100ms @ 16kHz mono PCM16
        const firstChunk = pcm16.subarray(0, Math.min(chunkBytes, pcm16.length));
        await ctx.client.sendVoiceAudioChunk(firstChunk.toString("base64"), format, false);
        await earlyTranscription
          .then(() => {
            throw new Error("Expected no transcription_result before isLast=true");
          })
          .catch(() => {});

        for (let offset = chunkBytes; offset < pcm16.length; offset += chunkBytes) {
          const chunk = pcm16.subarray(offset, Math.min(pcm16.length, offset + chunkBytes));
          const isLast = offset + chunkBytes >= pcm16.length;
          await ctx.client.sendVoiceAudioChunk(chunk.toString("base64"), format, isLast);
        }

        const outcome = await Promise.race([
          transcription.then((payload) => ({ kind: "ok" as const, payload })),
          errorSignal.then((error) => ({ kind: "error" as const, error })),
        ]);

        if (outcome.kind === "error") {
          throw new Error(outcome.error);
        }

        expect(typeof outcome.payload.text).toBe("string");
        if (outcome.payload.text.trim().length > 0) {
          expect(outcome.payload.text.toLowerCase()).toContain("voice note");
        } else {
          expect(outcome.payload.isLowConfidence).toBe(true);
        }
      } finally {
        await Promise.allSettled([transcription, errorSignal]);
        await ctx.client.setVoiceMode(false);
        rmSync(voiceCwd, { recursive: true, force: true });
      }
    },
    90_000
  );

  speechTest(
    "voice mode flushes buffered audio after inactivity when isLast is missing",
    async () => {
      const voiceCwd = tmpCwd();
      const voiceAgent = await ctx.client.createAgent({
        config: {
          ...getFullAccessConfig("codex"),
          cwd: voiceCwd,
        },
      });
      await ctx.client.setVoiceMode(true, voiceAgent.id);

      const transcription = waitForSignal(40_000, (resolve) => {
        const unsubscribe = ctx.client.on("transcription_result", (message) => {
          if (message.type !== "transcription_result") {
            return;
          }
          resolve(message.payload);
        });
        return unsubscribe;
      });

      const errorSignal = waitForSignal(40_000, (resolve) => {
        const unsubscribeStatus = ctx.client.on("status", (message) => {
          if (message.type !== "status") {
            return;
          }
          if (message.payload.status !== "error") {
            return;
          }
          resolve(`status:error ${message.payload.message}`);
        });

        const unsubscribeLog = ctx.client.on("activity_log", (message) => {
          if (message.type !== "activity_log") {
            return;
          }
          if (message.payload.type !== "error") {
            return;
          }
          resolve(`activity_log:error ${message.payload.content}`);
        });

        return () => {
          unsubscribeStatus();
          unsubscribeLog();
        };
      });

      try {
        const fixturePath = path.resolve(
          process.cwd(),
          "..",
          "app",
          "e2e",
          "fixtures",
          "recording.wav"
        );
        const wav = await import("node:fs/promises").then((fs) => fs.readFile(fixturePath));
        const { sampleRate, pcm16 } = parsePcm16MonoWav(wav);
        expect(sampleRate).toBe(16000);

        const format = "audio/pcm;rate=16000;bits=16";
        const chunkBytes = 3200; // 100ms @ 16kHz mono PCM16
        const maxChunksWithoutLast = 25;

        let sentChunks = 0;
        for (
          let offset = 0;
          offset < pcm16.length && sentChunks < maxChunksWithoutLast;
          offset += chunkBytes
        ) {
          const chunk = pcm16.subarray(offset, Math.min(pcm16.length, offset + chunkBytes));
          await ctx.client.sendVoiceAudioChunk(chunk.toString("base64"), format, false);
          sentChunks += 1;
        }

        const outcome = await Promise.race([
          transcription.then((payload) => ({ kind: "ok" as const, payload })),
          errorSignal.then((error) => ({ kind: "error" as const, error })),
        ]);

        if (outcome.kind === "error") {
          throw new Error(outcome.error);
        }

        expect(typeof outcome.payload.text).toBe("string");
        if (outcome.payload.byteLength !== undefined) {
          expect(outcome.payload.byteLength).toBeGreaterThan(0);
        }
        if (outcome.payload.text.trim().length > 0) {
          expect(outcome.payload.text.trim().length).toBeGreaterThan(1);
        } else {
          expect(outcome.payload.isLowConfidence).toBe(true);
        }
      } finally {
        await Promise.allSettled([transcription, errorSignal]);
        await ctx.client.setVoiceMode(false);
        rmSync(voiceCwd, { recursive: true, force: true });
      }
    },
    90_000
  );

  speechTest(
    "streams dictation PCM and returns final transcript",
    async () => {
      const fixturePath = path.resolve(
        process.cwd(),
        "..",
        "app",
        "e2e",
        "fixtures",
        "recording.wav"
      );
      const wav = await import("node:fs/promises").then((fs) => fs.readFile(fixturePath));
      const { sampleRate, pcm16 } = parsePcm16MonoWav(wav);
      expect(sampleRate).toBe(16000);
      const dictationId = `dict-${Date.now()}`;
      const format = "audio/pcm;rate=16000;bits=16";

      await ctx.client.startDictationStream(dictationId, format);

      const chunkBytes = 3200; // ~100ms @ 16kHz mono PCM16 (1600 samples * 2 bytes)
      let seq = 0;
      for (let offset = 0; offset < pcm16.length; offset += chunkBytes) {
        const chunk = pcm16.subarray(offset, Math.min(pcm16.length, offset + chunkBytes));
        ctx.client.sendDictationStreamChunk(dictationId, seq, chunk.toString("base64"), format);
        seq += 1;
      }

      const finalSeq = seq - 1;
      const result = await ctx.client.finishDictationStream(dictationId, finalSeq);

      expect(result.dictationId).toBe(dictationId);
      expect(result.text.toLowerCase()).toContain("voice note");
    },
    30_000
  );

  speechTest(
    "realtime dictation transcript is similar to baseline fixture",
    async () => {
      const fixturePath = path.resolve(
        process.cwd(),
        "..",
        "app",
        "e2e",
        "fixtures",
        "recording.wav"
      );
      const wav = await import("node:fs/promises").then((fs) => fs.readFile(fixturePath));
      const { sampleRate, pcm16 } = parsePcm16MonoWav(wav);
      expect(sampleRate).toBe(16000);
      const dictationId = `dict-baseline-${Date.now()}`;
      const format = "audio/pcm;rate=16000;bits=16";

      const baselinePath = path.resolve(
        process.cwd(),
        "..",
        "app",
        "e2e",
        "fixtures",
        "recording.baseline.txt"
      );
      const baseline = await import("node:fs/promises")
        .then((fs) => fs.readFile(baselinePath, "utf-8"))
        .then((text) => text.trim());

      await ctx.client.startDictationStream(dictationId, format);

      const chunkBytes = 3200; // 100ms @ 16kHz mono PCM16
      let seq = 0;
      for (let offset = 0; offset < pcm16.length; offset += chunkBytes) {
        const chunk = pcm16.subarray(offset, Math.min(pcm16.length, offset + chunkBytes));
        ctx.client.sendDictationStreamChunk(dictationId, seq, chunk.toString("base64"), format);
        seq += 1;
      }

      const finalSeq = seq - 1;
      const result = await ctx.client.finishDictationStream(dictationId, finalSeq);

      expect(result.dictationId).toBe(dictationId);
      expect(wordSimilarity(result.text, baseline)).toBeGreaterThan(0.6);
    },
    30_000
  );

  speechTest(
    "fails fast if dictation finishes without sending required chunks",
    async () => {
      const dictationId = `dict-missing-chunks-${Date.now()}`;
      const format = "audio/pcm;rate=16000;bits=16";

      await ctx.client.startDictationStream(dictationId, format);

      // Claim that we sent chunk 0, but actually send no chunks.
      await expect(ctx.client.finishDictationStream(dictationId, 0)).rejects.toThrow(
        /no audio chunks were received/i
      );
    },
    15_000
  );

  test(
    "supports git and file operations",
    async () => {
      const cwd = tmpCwd();

      execSync("git init -b main", { cwd, stdio: "pipe" });
      execSync("git config user.email 'test@test.com'", {
        cwd,
        stdio: "pipe",
      });
      execSync("git config user.name 'Test'", { cwd, stdio: "pipe" });

      const testFile = path.join(cwd, "test.txt");
      writeFileSync(testFile, "original content\n");
      execSync("git add test.txt", { cwd, stdio: "pipe" });
      execSync("git -c commit.gpgSign=false commit -m 'Initial commit'", {
        cwd,
        stdio: "pipe",
      });

      writeFileSync(testFile, "modified content\n");

      const downloadFile = path.join(cwd, "download.txt");
      const downloadContents = "download payload";
      writeFileSync(downloadFile, downloadContents, "utf-8");

      const agent = await ctx.client.createAgent({
        ...getFullAccessConfig("codex"),
        cwd,
        title: "Git/File Test",
      });

      // Test checkout status RPC
      const checkoutStatus = await ctx.client.getCheckoutStatus(cwd);
      expect(checkoutStatus.error).toBeNull();
      expect(checkoutStatus.isGit).toBe(true);
      expect(checkoutStatus.repoRoot).toContain(cwd);

      const diffResult = await ctx.client.getCheckoutDiff(cwd, { mode: "uncommitted" });
      expect(diffResult.error).toBeNull();
      expect(Array.isArray(diffResult.files)).toBe(true);
      expect(diffResult.files.length).toBeGreaterThan(0);
      expect(diffResult.files.some((file) => file.path === "test.txt")).toBe(true);

      const listRequestId = `list-${Date.now()}`;
      const listMessagePromise = waitForSignal(15000, (resolve) => {
        const unsubscribeList = ctx.client.on(
          "file_explorer_response",
          (message) => {
            if (message.type !== "file_explorer_response") {
              return;
            }
            if (message.payload.agentId !== agent.id) {
              return;
            }
            if (message.payload.mode !== "list") {
              return;
            }
            if (message.payload.requestId !== listRequestId) {
              return;
            }
            resolve(message);
          }
        );
        return unsubscribeList;
      });

      const listResult = await ctx.client.exploreFileSystem(
        agent.id,
        ".",
        "list",
        listRequestId
      );
      const listMessage = await listMessagePromise;
      expect(listResult.error).toBeNull();
      expect(listResult.directory).toBeTruthy();
      expect(listResult.requestId).toBe(listRequestId);
      expect(listMessage.payload.mode).toBe("list");
      expect(listMessage.payload.requestId).toBe(listRequestId);

      const fileRequestId = `file-${Date.now()}`;
      const fileMessagePromise = waitForSignal(15000, (resolve) => {
        const unsubscribeFile = ctx.client.on(
          "file_explorer_response",
          (message) => {
            if (message.type !== "file_explorer_response") {
              return;
            }
            if (message.payload.agentId !== agent.id) {
              return;
            }
            if (message.payload.mode !== "file") {
              return;
            }
            if (message.payload.requestId !== fileRequestId) {
              return;
            }
            resolve(message);
          }
        );
        return unsubscribeFile;
      });

      const fileResult = await ctx.client.exploreFileSystem(
        agent.id,
        "download.txt",
        "file",
        fileRequestId
      );
      const fileMessage = await fileMessagePromise;
      expect(fileResult.error).toBeNull();
      expect(fileResult.file?.content).toBe(downloadContents);
      expect(fileResult.requestId).toBe(fileRequestId);
      expect(fileMessage.payload.mode).toBe("file");
      expect(fileMessage.payload.requestId).toBe(fileRequestId);

      const tokenRequestId = `token-${Date.now()}`;
      const tokenMessagePromise = waitForSignal(15000, (resolve) => {
        const unsubscribeToken = ctx.client.on(
          "file_download_token_response",
          (message) => {
            if (message.type !== "file_download_token_response") {
              return;
            }
            if (message.payload.agentId !== agent.id) {
              return;
            }
            if (!message.payload.path.endsWith("download.txt")) {
              return;
            }
            if (message.payload.requestId !== tokenRequestId) {
              return;
            }
            resolve(message);
          }
        );
        return unsubscribeToken;
      });

      const tokenResponse = await ctx.client.requestDownloadToken(
        agent.id,
        "download.txt",
        tokenRequestId
      );
      const tokenMessage = await tokenMessagePromise;
      expect(tokenResponse.error).toBeNull();
      expect(tokenResponse.token).toBeTruthy();
      expect(tokenResponse.requestId).toBe(tokenRequestId);
      expect(tokenMessage.payload.agentId).toBe(agent.id);
      expect(tokenMessage.payload.requestId).toBe(tokenRequestId);

      const response = await fetch(
        `http://127.0.0.1:${ctx.daemon.port}/api/files/download?token=${tokenResponse.token}`
      );

      expect(response.status).toBe(200);
      const body = await response.text();
      expect(body).toBe(downloadContents);

      await ctx.client.deleteAgent(agent.id);
      rmSync(cwd, { recursive: true, force: true });
    },
    120000
  );
});

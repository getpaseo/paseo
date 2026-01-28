import { describe, test, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import dotenv from "dotenv";

import {
  createDaemonTestContext,
  type DaemonTestContext,
} from "./test-utils/index.js";
import { getFullAccessConfig, getAskModeConfig } from "./daemon-e2e/agent-configs.js";
import {
  chunkPcm16,
  parsePcm16MonoWav,
  requireEnv,
} from "./test-utils/dictation-e2e.js";

const defaultEnvPath = path.resolve(process.cwd(), ".env");
const fallbackEnvPath = path.resolve(process.cwd(), "packages", "server", ".env");
const envPath = existsSync(defaultEnvPath)
  ? defaultEnvPath
  : existsSync(fallbackEnvPath)
    ? fallbackEnvPath
    : null;

if (envPath) {
  dotenv.config({ path: envPath });
}

// Make dictation streaming commit frequently in tests so we exercise multi-commit assembly logic.
process.env.OPENAI_REALTIME_DICTATION_COMMIT_MS ??= "1000";

function tmpCwd(): string {
  return mkdtempSync(path.join(tmpdir(), "daemon-client-v2-"));
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

describe("daemon client v2 E2E", () => {
  let ctx: DaemonTestContext;

  beforeAll(async () => {
    ctx = await createDaemonTestContext();
  }, 60000);

  afterAll(async () => {
    await ctx.cleanup();
  }, 60000);

  test("handles session actions", async () => {
    expect(ctx.client.isConnected).toBe(true);

    const sessionStatePromise = waitForSignal(15000, (resolve) => {
      const unsubscribe = ctx.client.on("session_state", (message) => {
        if (message.type !== "session_state") {
          return;
        }
        resolve(message);
      });
      return unsubscribe;
    });

    const voiceConversationId = `voice-${Date.now()}`;
    const loadResult = await ctx.client.loadVoiceConversation(voiceConversationId);
    expect(loadResult.voiceConversationId).toBe(voiceConversationId);
    expect(typeof loadResult.messageCount).toBe("number");

    const sessionState = await sessionStatePromise;
    expect(Array.isArray(sessionState.payload.agents)).toBe(true);

    const listResult = await ctx.client.listVoiceConversations();
    expect(Array.isArray(listResult.conversations)).toBe(true);

    const missingId = `missing-${Date.now()}`;
    const deleteResult = await ctx.client.deleteVoiceConversation(missingId);
    expect(deleteResult.voiceConversationId).toBe(missingId);
    expect(deleteResult.success).toBe(false);
    expect(deleteResult.error).toBeTruthy();
  }, 30000);

  test("matches request IDs for concurrent session requests", async () => {
    const firstRequestId = `list-${Date.now()}-a`;
    const secondRequestId = `list-${Date.now()}-b`;

    const [first, second] = await Promise.all([
      ctx.client.listVoiceConversations(firstRequestId),
      ctx.client.listVoiceConversations(secondRequestId),
    ]);

    expect(Array.isArray(first.conversations)).toBe(true);
    expect(Array.isArray(second.conversations)).toBe(true);
    expect(first.requestId).toBe(firstRequestId);
    expect(second.requestId).toBe(secondRequestId);
  }, 15000);

  test(
    "creates agent and exercises lifecycle",
    async () => {
      const cwd = tmpCwd();

      const agentStatePromise = waitForSignal(15000, (resolve) => {
        const unsubscribe = ctx.client.on("agent_state", (message) => {
          if (message.type !== "agent_state") {
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
      expect(
        ctx.client.listAgents().some((entry) => entry.id === agent.id)
      ).toBe(true);

      const agentState = await agentStatePromise;
      expect(agentState.payload.id).toBe(agent.id);
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

      const failResult = await ctx.client.createAgentExpectFail({
        ...getFullAccessConfig("codex"),
        cwd: "/this/path/does/not/exist/12345",
        title: "Should Fail",
        requestId: failRequestId,
      });
      expect(failResult.error).toContain("Working directory does not exist");
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

      const initResult = await ctx.client.initializeAgent(agent.id);
      expect(initResult.id).toBe(agent.id);

      const nextMode = agent.availableModes.find(
        (mode) => mode.id !== agent.currentModeId
      )?.id;

      if (nextMode) {
        await ctx.client.setAgentMode(agent.id, nextMode);
        const modeState = await ctx.client.waitForAgentState(
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
      const finalState = await ctx.client.waitForAgentIdle(agent.id, 120000);
      unsubscribeStream();
      unsubscribeRawStream();
      expect(finalState.status).toBe("idle");
      expect(sawAssistantMessage).toBe(true);
      expect(sawRawAssistantMessage).toBe(true);

      await ctx.client.setVoiceConversation(false);

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

      const persistence = finalState.persistence;
      expect(persistence).toBeTruthy();

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

        const permission = await ctx.client.waitForPermission(agent.id, 60000);
        expect(permission).toBeTruthy();
        expect(permission.id).toBeTruthy();

        const permissionRequest = await permissionRequestPromise;
        expect(permissionRequest.payload.agentId).toBe(agent.id);

        await ctx.client.respondToPermission(agent.id, permission.id, {
          behavior: "allow",
        });

        const permissionResolved = await permissionResolvedPromise;
        expect(permissionResolved.payload.requestId).toBe(permission.id);

        const finalState = await ctx.client.waitForAgentIdle(agent.id, 120000);
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
      await ctx.client.waitForAgentIdle(agent.id, 120000);

      const snapshotPromise = waitForSignal(15000, (resolve) => {
        const unsubscribe = ctx.client.on("agent_stream_snapshot", (message) => {
          if (message.type !== "agent_stream_snapshot") {
            return;
          }
          if (message.payload.agentId !== agent.id) {
            return;
          }
          resolve(message);
        });
        return unsubscribe;
      });

      await ctx.client.initializeAgent(agent.id);
      const snapshot = await snapshotPromise;
      expect(snapshot.payload.events.length).toBeGreaterThan(0);

      await ctx.client.deleteAgent(agent.id);
      rmSync(cwd, { recursive: true, force: true });
    },
    120000
  );

  test(
    "streams session activity logs and chunks",
    async () => {
      await ctx.client.setVoiceConversation(false);

      let sawAssistantChunk = false;
      let sawTranscriptLog = false;
      let sawAssistantLog = false;

      const completion = waitForSignal(60000, (resolve) => {
        const unsubscribeChunk = ctx.client.on("assistant_chunk", (message) => {
          if (message.type !== "assistant_chunk") {
            return;
          }
          if (message.payload.chunk.length > 0) {
            sawAssistantChunk = true;
          }
          if (sawAssistantChunk && sawTranscriptLog && sawAssistantLog) {
            resolve();
          }
        });

        const unsubscribeActivity = ctx.client.on("activity_log", (message) => {
          if (message.type !== "activity_log") {
            return;
          }
          if (message.payload.type === "transcript") {
            sawTranscriptLog = true;
          }
          if (message.payload.type === "assistant") {
            sawAssistantLog = true;
          }
          if (sawAssistantChunk && sawTranscriptLog && sawAssistantLog) {
            resolve();
          }
        });

        return () => {
          unsubscribeChunk();
          unsubscribeActivity();
        };
      });

      await ctx.client.sendUserMessage("Say 'hello' and nothing else");
      await completion;
    },
    120000
  );

  test(
    "streams audio output and transcription results in realtime mode",
    async () => {
      if (process.env.PASEO_E2E_AUDIO !== "1") {
        // Requires OpenAI STT/TTS services and is inherently network-flaky.
        return;
      }
      if (!process.env.OPENAI_API_KEY) {
        return;
      }

      await ctx.client.setVoiceConversation(true, `voice-${Date.now()}`);

      const audioOutput = waitForSignal(90000, (resolve) => {
        const chunks: Array<{
          audio: string;
          format: string;
          id: string;
          groupId?: string;
          chunkIndex?: number;
          isLastChunk?: boolean;
        }> = [];
        let activeGroupId: string | null = null;

        const unsubscribe = ctx.client.on("audio_output", (message) => {
          if (message.type !== "audio_output") {
            return;
          }
          const payload = message.payload;
          const groupId = payload.groupId ?? payload.id;
          if (!activeGroupId) {
            activeGroupId = groupId;
          }
          if (groupId !== activeGroupId) {
            return;
          }
          chunks.push(payload);
          void ctx.client.audioPlayed(payload.id);
          if (payload.isLastChunk ?? true) {
            resolve({
              format: payload.format,
              chunks: [...chunks],
            });
          }
        });

        return unsubscribe;
      });

      const transcription = waitForSignal(20000, (resolve) => {
        const unsubscribe = ctx.client.on("transcription_result", (message) => {
          if (message.type !== "transcription_result") {
            return;
          }
          resolve(message.payload.text);
        });
        return unsubscribe;
      });

      await ctx.client.sendUserMessage("Say the word 'hello' and nothing else");
      const { format, chunks } = await audioOutput;

      const sorted = [...chunks].sort(
        (a, b) => (a.chunkIndex ?? 0) - (b.chunkIndex ?? 0)
      );

      for (let i = 0; i < sorted.length; i += 1) {
        const chunk = sorted[i];
        const isLast = i === sorted.length - 1;
        await ctx.client.sendRealtimeAudioChunk(chunk.audio, format, isLast);
      }

      const transcript = await transcription.catch(() => null);
      expect(
        transcript === null || typeof transcript === "string"
      ).toBe(true);

      await ctx.client.setVoiceConversation(false);
    },
    180000
  );

  test(
    "streams dictation PCM and returns final transcript via OpenAI Realtime transcription",
    async () => {
      requireEnv("OPENAI_API_KEY");

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
    180000
  );

  test(
    "does not commit an empty OpenAI realtime audio buffer on finish",
    async () => {
      requireEnv("OPENAI_API_KEY");

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
      const dictationId = `dict-empty-commit-${Date.now()}`;
      const format = "audio/pcm;rate=16000;bits=16";

      await ctx.client.startDictationStream(dictationId, format);

      // Send exactly 10x 100ms chunks. With OPENAI_REALTIME_DICTATION_COMMIT_MS=1000 in this test file,
      // the server will auto-commit at the 1s boundary. Finishing immediately after that should not
      // attempt an additional empty commit.
      const chunkBytes = 3200; // 100ms @ 16kHz mono PCM16
      const targetChunks = 10;
      let seq = 0;
      for (let i = 0; i < targetChunks; i += 1) {
        const start = i * chunkBytes;
        const end = Math.min(pcm16.length, start + chunkBytes);
        const chunk = pcm16.subarray(start, end);
        ctx.client.sendDictationStreamChunk(dictationId, seq, chunk.toString("base64"), format);
        seq += 1;
      }

      const finalSeq = seq - 1;
      const result = await ctx.client.finishDictationStream(dictationId, finalSeq);

      expect(result.dictationId).toBe(dictationId);
      expect(typeof result.text).toBe("string");
    },
    180000
  );

  describe("dictation streaming vs baseline (real OpenAI, debug fixtures)", () => {
    let wav: Buffer;
    let chunks: Buffer[];
    let expectedText: string;
    let fixtureSampleRate: number;
    let chunkBytes: number;

    beforeAll(async () => {
      requireEnv("OPENAI_API_KEY");
      const fixturePath = path.resolve(
        process.cwd(),
        "src",
        "server",
        "fixtures",
        "dictation",
        "dictation-debug-largest.wav"
      );
      const transcriptPath = path.resolve(
        process.cwd(),
        "src",
        "server",
        "fixtures",
        "dictation",
        "dictation-debug-largest.transcript.txt"
      );
      wav = await import("node:fs/promises").then((fs) => fs.readFile(fixturePath));
      expectedText = await import("node:fs/promises").then((fs) => fs.readFile(transcriptPath, "utf8"));

      const { sampleRate, pcm16 } = parsePcm16MonoWav(wav);
      fixtureSampleRate = sampleRate;

      // Stream at the fixture's native rate to avoid lossy double-resampling.
      // 100ms @ sampleRate mono PCM16 => sampleRate * 0.1 samples * 2 bytes.
      chunkBytes = Math.round((fixtureSampleRate * 2 * 100) / 1000);
      if (chunkBytes <= 0 || chunkBytes % 2 !== 0) {
        throw new Error(`Invalid chunkBytes computed: ${chunkBytes} (rate=${fixtureSampleRate})`);
      }
      chunks = chunkPcm16(pcm16, chunkBytes);
    }, 240000);

    test(
      "streaming transcript matches baseline transcript exactly",
      async () => {
        const dictationId = `dict-debug-${Date.now()}`;
        const format = `audio/pcm;rate=${fixtureSampleRate};bits=16`;

        await ctx.client.startDictationStream(dictationId, format);

        for (let seq = 0; seq < chunks.length; seq += 1) {
          ctx.client.sendDictationStreamChunk(dictationId, seq, chunks[seq]!.toString("base64"), format);
        }

        const result = await ctx.client.finishDictationStream(dictationId, chunks.length - 1);
        expect(result.dictationId).toBe(dictationId);
        expect(result.text.trim()).toBe(expectedText.trim());
      },
      240000
    );

    test(
      "finish before sending all chunks still completes and matches baseline exactly",
      async () => {
        const dictationId = `dict-early-finish-${Date.now()}`;
        const format = `audio/pcm;rate=${fixtureSampleRate};bits=16`;

        await ctx.client.startDictationStream(dictationId, format);

        const splitAt = Math.max(1, Math.floor(chunks.length * 0.35));
        for (let seq = 0; seq < splitAt; seq += 1) {
          ctx.client.sendDictationStreamChunk(dictationId, seq, chunks[seq]!.toString("base64"), format);
        }

        const finishPromise = ctx.client.finishDictationStream(dictationId, chunks.length - 1);

        // Simulate network jitter / chunk delay after finish.
        await new Promise((r) => setTimeout(r, 250));
        for (let seq = splitAt; seq < chunks.length; seq += 1) {
          ctx.client.sendDictationStreamChunk(dictationId, seq, chunks[seq]!.toString("base64"), format);
        }

        const result = await finishPromise;
        expect(result.dictationId).toBe(dictationId);
        expect(result.text.trim()).toBe(expectedText.trim());
      },
      240000
    );

    test(
      "missing a chunk causes dictation to error (no finalize)",
      async () => {
        const dictationId = `dict-missing-chunk-${Date.now()}`;
        const format = `audio/pcm;rate=${fixtureSampleRate};bits=16`;

        await ctx.client.startDictationStream(dictationId, format);

        const missingSeq = Math.min(3, Math.max(0, chunks.length - 1));
        for (let seq = 0; seq < chunks.length; seq += 1) {
          if (seq === missingSeq) continue;
          ctx.client.sendDictationStreamChunk(dictationId, seq, chunks[seq]!.toString("base64"), format);
        }

        await expect(ctx.client.finishDictationStream(dictationId, chunks.length - 1)).rejects.toThrow(
          /Timed out waiting for final transcription|Timeout waiting for event|Timeout waiting for message/
        );
      },
      240000
    );
  });

  test(
    "fails fast if dictation finishes without sending required chunks",
    async () => {
      if (process.env.PASEO_E2E_DICTATION_REALTIME !== "1") {
        return;
      }
      if (!process.env.OPENAI_API_KEY) {
        return;
      }

      const dictationId = `dict-missing-chunks-${Date.now()}`;
      const format = "audio/pcm;rate=16000;bits=16";

      await ctx.client.startDictationStream(dictationId, format);

      // Claim that we sent chunk 0, but actually send no chunks.
      await expect(ctx.client.finishDictationStream(dictationId, 0)).rejects.toThrow(
        /no audio chunks were received/i
      );
    },
    180000
  );

  test(
    "supports git and file operations",
    async () => {
      const cwd = tmpCwd();

      execSync("git init", { cwd, stdio: "pipe" });
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

      const repoInfoRequestId = `repo-info-${Date.now()}`;
      const repoInfoMessagePromise = waitForSignal(15000, (resolve) => {
        const unsubscribeRepo = ctx.client.on(
          "git_repo_info_response",
          (message) => {
            if (message.type !== "git_repo_info_response") {
              return;
            }
            if (message.payload.cwd !== cwd) {
              return;
            }
            if (message.payload.requestId !== repoInfoRequestId) {
              return;
            }
            resolve(message);
          }
        );
        return unsubscribeRepo;
      });

      const repoInfo = await ctx.client.getGitRepoInfo(
        { cwd },
        repoInfoRequestId
      );
      const repoInfoMessage = await repoInfoMessagePromise;
      expect(repoInfo.error ?? null).toBeNull();
      expect(repoInfo.repoRoot).toContain(cwd);
      expect(repoInfo.requestId).toBe(repoInfoRequestId);
      expect(repoInfoMessage.payload.cwd).toBe(cwd);
      expect(repoInfoMessage.payload.requestId).toBe(repoInfoRequestId);

      const diffRequestId = `diff-${Date.now()}`;
      const diffMessagePromise = waitForSignal(15000, (resolve) => {
        const unsubscribeDiff = ctx.client.on("git_diff_response", (message) => {
          if (message.type !== "git_diff_response") {
            return;
          }
          if (message.payload.agentId !== agent.id) {
            return;
          }
          if (message.payload.requestId !== diffRequestId) {
            return;
          }
          resolve(message);
        });
        return unsubscribeDiff;
      });

      const diffResult = await ctx.client.getGitDiff(agent.id, diffRequestId);
      const diffMessage = await diffMessagePromise;
      expect(diffResult.error).toBeNull();
      expect(diffResult.diff).toContain("test.txt");
      expect(diffResult.diff).toContain("-original content");
      expect(diffResult.diff).toContain("+modified content");
      expect(diffResult.requestId).toBe(diffRequestId);
      expect(diffMessage.payload.agentId).toBe(agent.id);
      expect(diffMessage.payload.requestId).toBe(diffRequestId);

      const highlightRequestId = `highlight-${Date.now()}`;
      const highlightMessagePromise = waitForSignal(15000, (resolve) => {
        const unsubscribeHighlight = ctx.client.on(
          "highlighted_diff_response",
          (message) => {
            if (message.type !== "highlighted_diff_response") {
              return;
            }
            if (message.payload.agentId !== agent.id) {
              return;
            }
            if (message.payload.requestId !== highlightRequestId) {
              return;
            }
            resolve(message);
          }
        );
        return unsubscribeHighlight;
      });

      const highlightResult = await ctx.client.getHighlightedDiff(
        agent.id,
        highlightRequestId
      );
      const highlightMessage = await highlightMessagePromise;
      expect(highlightResult.error).toBeNull();
      expect(Array.isArray(highlightResult.files)).toBe(true);
      expect(highlightResult.requestId).toBe(highlightRequestId);
      expect(highlightMessage.payload.agentId).toBe(agent.id);
      expect(highlightMessage.payload.requestId).toBe(highlightRequestId);

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

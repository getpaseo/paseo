import { describe, test, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

import {
  createDaemonTestContext,
  type DaemonTestContext,
  DaemonClient,
} from "./test-utils/index.js";
import { getFullAccessConfig, getAskModeConfig } from "./daemon-e2e/agent-configs.js";
import {
  chunkPcm16,
  parsePcm16MonoWav,
  requireEnv,
  transcribeBaselineOpenAI,
  wordSimilarity,
} from "./test-utils/dictation-e2e.js";

const hasOpenAICredentials = !!process.env.OPENAI_API_KEY;

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

(hasOpenAICredentials ? describe : describe.skip)("daemon client E2E", () => {
  let ctx: DaemonTestContext;

  beforeAll(async () => {
    const openaiApiKey = process.env.OPENAI_API_KEY ?? "";
    ctx = await createDaemonTestContext({
      dictationFinalTimeoutMs: 5000,
      openai: { apiKey: openaiApiKey },
    });
  }, 60000);

  afterAll(async () => {
    await ctx.cleanup();
  }, 60000);

  test("handles session actions", async () => {
    expect(ctx.client.isConnected).toBe(true);

    const voiceConversationId = `voice-${Date.now()}`;
    const loadResult = await ctx.client.loadVoiceConversation(voiceConversationId);
    expect(loadResult.voiceConversationId).toBe(voiceConversationId);
    expect(typeof loadResult.messageCount).toBe("number");

    const agents = await ctx.client.fetchAgents();
    expect(Array.isArray(agents)).toBe(true);

    const listResult = await ctx.client.listVoiceConversations();
    expect(Array.isArray(listResult.conversations)).toBe(true);

    const missingId = `missing-${Date.now()}`;
    const deleteResult = await ctx.client.deleteVoiceConversation(missingId);
    expect(deleteResult.voiceConversationId).toBe(missingId);
    expect(deleteResult.success).toBe(false);
    expect(deleteResult.error).toBeTruthy();
  }, 30000);

  test("emits server_info on websocket connect", async () => {
    const client = new DaemonClient({
      url: `ws://127.0.0.1:${ctx.daemon.port}/ws`,
    });

    const infoPromise = waitForSignal<{ serverId: string }>(5000, (resolve) => {
      const unsubscribe = client.on("status", (message) => {
        if (message.type !== "status") return;
        const payload = message.payload as { status?: unknown; serverId?: unknown };
        if (payload.status !== "server_info") return;
        if (typeof payload.serverId !== "string" || payload.serverId.trim().length === 0) return;
        resolve({ serverId: payload.serverId.trim() });
      });
      return unsubscribe;
    });

    await client.connect();
    const info = await infoPromise;
    expect(info.serverId.length).toBeGreaterThan(0);

    await client.close();
  }, 15000);

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

      const initResult = await ctx.client.initializeAgent(agent.id);
      expect(initResult.id).toBe(agent.id);

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

  test.runIf(Boolean(process.env.OPENROUTER_API_KEY))(
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
    "voice mode buffers audio until isLast and emits transcription_result",
    async () => {
      requireEnv("OPENAI_API_KEY");

      await ctx.client.setVoiceConversation(true, `voice-${Date.now()}`);

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
        await ctx.client.setVoiceConversation(false);
      }
    },
    90_000
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
    30_000
  );

  test(
    "realtime dictation transcript is similar to baseline (OpenAI transcriptions API)",
    async () => {
      const apiKey = requireEnv("OPENAI_API_KEY");

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

      const baseline = await transcribeBaselineOpenAI({
        apiKey,
        wav,
        model: process.env.STT_MODEL ?? "whisper-1",
        prompt:
          process.env.OPENAI_REALTIME_DICTATION_TRANSCRIPTION_PROMPT ??
          "Transcribe only what the speaker says. Do not add words. Preserve punctuation and casing. If the audio is silence or non-speech noise, return an empty transcript.",
      });

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
      expect(wordSimilarity(result.text, baseline)).toBeGreaterThan(0.8);
    },
    30_000
  );

  test(
    "fails fast if dictation finishes without sending required chunks",
    async () => {
      requireEnv("OPENAI_API_KEY");

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

      // Test checkout status RPC
      const checkoutStatus = await ctx.client.getCheckoutStatus(cwd);
      expect(checkoutStatus.error).toBeNull();
      expect(checkoutStatus.isGit).toBe(true);
      expect(checkoutStatus.repoRoot).toContain(cwd);

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

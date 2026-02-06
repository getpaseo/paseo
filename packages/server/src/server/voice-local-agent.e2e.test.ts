import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { randomUUID } from "node:crypto";

import { createDaemonTestContext, type DaemonTestContext } from "./test-utils/index.js";

const openaiApiKey = process.env.OPENAI_API_KEY ?? null;
const shouldRun =
  process.env.PASEO_VOICE_LOCAL_AGENT_E2E === "1" &&
  Boolean(openaiApiKey) &&
  !process.env.CI;

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
      cleanup?.();
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

(shouldRun ? describe : describe.skip)(
  "voice local-agent e2e",
  () => {
    let ctx: DaemonTestContext;

    beforeAll(async () => {
      ctx = await createDaemonTestContext({
        agentClients: {},
        openai: { apiKey: openaiApiKey! },
        speech: {
          dictationSttProvider: "openai",
          voiceSttProvider: "openai",
          voiceTtsProvider: "openai",
        },
        voiceLlmProvider: "codex",
        voiceLlmProviderExplicit: true,
        voiceLlmModel: "gpt-5.2-mini",
      });
    }, 120000);

    afterAll(async () => {
      await ctx.cleanup();
    }, 60000);

    test(
      "routes voice turns through local agent speak tool",
      async () => {
        await ctx.client.setVoiceConversation(true, randomUUID());

        const audioPromise = waitForSignal<{ chunkId: string }>(120000, (resolve, reject) => {
          const offAudio = ctx.client.on("audio_output", (msg) => {
            if (msg.type !== "audio_output") return;
            resolve({ chunkId: msg.payload.id });
          });
          const offError = ctx.client.on("activity_log", (msg) => {
            if (msg.type !== "activity_log") return;
            if (msg.payload.type !== "error") return;
            reject(new Error(String(msg.payload.content)));
          });
          return () => {
            offAudio();
            offError();
          };
        });

        const assistantLogPromise = waitForSignal<string>(120000, (resolve, reject) => {
          const offLog = ctx.client.on("activity_log", (msg) => {
            if (msg.type !== "activity_log") return;
            if (msg.payload.type !== "assistant") return;
            const content = String(msg.payload.content ?? "");
            if (!content.trim()) return;
            resolve(content);
          });
          const offError = ctx.client.on("activity_log", (msg) => {
            if (msg.type !== "activity_log") return;
            if (msg.payload.type !== "error") return;
            reject(new Error(String(msg.payload.content)));
          });
          return () => {
            offLog();
            offError();
          };
        });

        ctx.client.sendUserMessage(
          "Use the speak tool and say exactly: local voice agent path is working."
        );

        const [{ chunkId }, assistantText] = await Promise.all([
          audioPromise,
          assistantLogPromise,
        ]);

        expect(chunkId.length).toBeGreaterThan(0);
        expect(assistantText.toLowerCase()).toContain("local voice agent path is working");

        const agents = await ctx.client.fetchAgents();
        expect(
          agents.some((agent) => String(agent.labels?.surface ?? "") === "voice")
        ).toBe(false);
      },
      180000
    );
  }
);

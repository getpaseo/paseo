import { describe, test, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { v4 as uuidv4 } from "uuid";

import { createTestPaseoDaemon } from "./test-utils/paseo-daemon.js";
import { DaemonClient } from "./test-utils/daemon-client.js";

async function waitForFile(filepath: string, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (existsSync(filepath)) {
      return;
    }
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Timed out waiting for file: ${filepath}`);
    }
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function waitForJsonFile<T>(
  filepath: string,
  timeoutMs = 5000
): Promise<T> {
  const start = Date.now();
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (existsSync(filepath)) {
      try {
        const raw = readFileSync(filepath, "utf8");
        if (raw.trim().length > 0) {
          return JSON.parse(raw) as T;
        }
      } catch {
        // File may exist but still be mid-write; retry.
      }
    }
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Timed out waiting for valid JSON: ${filepath}`);
    }
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe("voice conversations - daemon E2E", () => {
  test(
    "two concurrent clients persist independently under paseoHome/voice-conversations",
    async () => {
      const daemon = await createTestPaseoDaemon();
      const url = `ws://127.0.0.1:${daemon.port}/ws`;

      const clientA = new DaemonClient({ url });
      const clientB = new DaemonClient({ url });
      await clientA.connect();
      await clientB.connect();

      try {
        const voiceConversationIdA = uuidv4();
        const voiceConversationIdB = uuidv4();

        await clientA.setVoiceConversation(true, voiceConversationIdA);
        await clientB.setVoiceConversation(true, voiceConversationIdB);

        // Minimal traffic to cause a persist without requiring external APIs.
        await clientA.setVoiceConversation(false);
        await clientB.setVoiceConversation(false);

        const fileA = join(
          daemon.paseoHome,
          "voice-conversations",
          `${voiceConversationIdA}.json`
        );
        const fileB = join(
          daemon.paseoHome,
          "voice-conversations",
          `${voiceConversationIdB}.json`
        );

        await waitForFile(fileA);
        await waitForFile(fileB);

        const dataA = await waitForJsonFile<{
          voiceConversationId: string;
          messageCount: number;
          messages: unknown[];
        }>(fileA);
        const dataB = await waitForJsonFile<{
          voiceConversationId: string;
          messageCount: number;
          messages: unknown[];
        }>(fileB);

        expect(dataA.voiceConversationId).toBe(voiceConversationIdA);
        expect(dataB.voiceConversationId).toBe(voiceConversationIdB);
        expect(dataA.messageCount).toBe(0);
        expect(dataB.messageCount).toBe(0);
        expect(Array.isArray(dataA.messages)).toBe(true);
        expect(Array.isArray(dataB.messages)).toBe(true);
      } finally {
        await clientA.close().catch(() => undefined);
        await clientB.close().catch(() => undefined);
        await daemon.close();
      }
    },
    30000
  );

  test(
    "WS attach ignores URL conversationId param for voice conversation state",
    async () => {
      const daemon = await createTestPaseoDaemon();
      const urlConversationId = `url-${uuidv4()}`;
      const url = `ws://127.0.0.1:${daemon.port}/ws?conversationId=${encodeURIComponent(
        urlConversationId
      )}`;

      const client = new DaemonClient({ url });
      await client.connect();

      try {
        const voiceConversationId = `client-${uuidv4()}`;
        await client.setVoiceConversation(true, voiceConversationId);
        await client.setVoiceConversation(false);

        const file = join(
          daemon.paseoHome,
          "voice-conversations",
          `${voiceConversationId}.json`
        );
        const urlFile = join(
          daemon.paseoHome,
          "voice-conversations",
          `${urlConversationId}.json`
        );

        await waitForFile(file);
        expect(existsSync(urlFile)).toBe(false);
      } finally {
        await client.close().catch(() => undefined);
        await daemon.close();
      }
    },
    30000
  );
});

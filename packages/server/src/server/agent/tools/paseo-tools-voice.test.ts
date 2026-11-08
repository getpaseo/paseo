import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { createTestLogger } from "../../../test-utils/test-logger.js";
import { AgentManager } from "../agent-manager.js";
import { AgentStorage } from "../agent-storage.js";
import { ProviderSnapshotManager } from "../provider-snapshot-manager.js";
import type { PaseoToolCatalog } from "../types.js";
import { createPaseoToolCatalog } from "./paseo-tools.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function createVoiceProbeCatalog(options: {
  enableVoiceTools?: boolean;
  callerAgentId?: string;
  callerVoice?: boolean;
}): Promise<PaseoToolCatalog> {
  const paseoHome = await mkdtemp(path.join(tmpdir(), "paseo-tools-voice-"));
  temporaryDirectories.push(paseoHome);
  const logger = createTestLogger();
  return createPaseoToolCatalog({
    agentManager: new AgentManager({ logger }),
    agentStorage: new AgentStorage(paseoHome, logger),
    providerSnapshotManager: new ProviderSnapshotManager({ logger }),
    logger,
    ...(options.callerAgentId ? { callerAgentId: options.callerAgentId } : {}),
    ...(options.enableVoiceTools === undefined
      ? {}
      : { enableVoiceTools: options.enableVoiceTools }),
    ...(options.callerAgentId
      ? {
          resolveCallerContext: () => ({
            enableVoiceTools: options.callerVoice ?? false,
          }),
        }
      : {}),
  });
}

describe("voice speak tool registration (#7212)", () => {
  test("omits speak without voice context", async () => {
    const catalog = await createVoiceProbeCatalog({});
    expect(catalog.tools.has("speak")).toBe(false);
  });

  test("includes speak with enableVoiceTools", async () => {
    const catalog = await createVoiceProbeCatalog({ enableVoiceTools: true });
    expect(catalog.tools.has("speak")).toBe(true);
  });

  test("includes speak for a voice-marked caller", async () => {
    const catalog = await createVoiceProbeCatalog({
      callerAgentId: "voice-agent",
      callerVoice: true,
    });
    expect(catalog.tools.has("speak")).toBe(true);
  });

  test("omits speak for a non-voice caller", async () => {
    const catalog = await createVoiceProbeCatalog({
      callerAgentId: "text-agent",
      callerVoice: false,
    });
    expect(catalog.tools.has("speak")).toBe(false);
  });
});

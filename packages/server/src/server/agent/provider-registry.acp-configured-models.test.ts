import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { createTestLogger } from "../../test-utils/test-logger.js";
import type { AgentSession } from "./agent-sdk-types.js";
import { buildProviderRegistry } from "./provider-registry.js";

// An ACP agent that advertises two models but, like Cline, runs any model id it is given.
const PERMISSIVE_MODEL_ACP_AGENT = `
import { Readable, Writable } from "node:stream";
const { AgentSideConnection, PROTOCOL_VERSION, ndJsonStream } = await import(process.env.ACP_SDK_URL);
let currentModelId = "advertised-default";
new AgentSideConnection(
  () => ({
    async initialize() {
      return { protocolVersion: PROTOCOL_VERSION, agentCapabilities: {} };
    },
    async newSession() {
      return {
        sessionId: "permissive-session",
        models: {
          currentModelId,
          availableModels: [
            { modelId: "advertised-default", name: "Advertised default" },
            { modelId: "advertised-other", name: "Advertised other" },
          ],
        },
      };
    },
    async unstable_setSessionModel({ modelId }) {
      currentModelId = modelId;
      return {};
    },
    async authenticate() {},
    async cancel() {},
    async prompt() {
      return { stopReason: "end_turn" };
    },
  }),
  ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)),
);
`;

describe("custom ACP provider with configured models", () => {
  let dir: string;
  let agentScript: string;
  let session: AgentSession | null = null;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "paseo-acp-configured-models-"));
    agentScript = path.join(dir, "agent.mjs");
    await writeFile(agentScript, PERMISSIVE_MODEL_ACP_AGENT);
  });

  afterEach(async () => {
    await session?.close();
    session = null;
    await rm(dir, { recursive: true, force: true });
  });

  function buildRegistry(override: {
    models?: Array<{ id: string; label: string }>;
    additionalModels?: Array<{ id: string; label: string }>;
  }) {
    return buildProviderRegistry(createTestLogger(), {
      providerOverrides: {
        permissive: {
          extends: "acp",
          label: "Permissive",
          command: [process.execPath, agentScript],
          env: {
            ACP_SDK_URL: pathToFileURL(
              createRequire(import.meta.url).resolve("@agentclientprotocol/sdk"),
            ).href,
          },
          ...override,
        },
      },
    });
  }

  async function createSessionOnModel(
    registry: ReturnType<typeof buildRegistry>,
    model: string,
  ): Promise<AgentSession> {
    const client = registry.permissive.createClient(createTestLogger());
    session = await client.createSession({ provider: "permissive", cwd: dir, model });
    return session;
  }

  test("runs on a model added through additionalModels that the agent does not advertise", async () => {
    const registry = buildRegistry({
      additionalModels: [{ id: "stealth/pixel-canary", label: "Pixel Canary" }],
    });

    const created = await createSessionOnModel(registry, "stealth/pixel-canary");

    expect((await created.getRuntimeInfo()).model).toBe("stealth/pixel-canary");
  });

  test("runs on a model from a replacement models list that the agent does not advertise", async () => {
    const registry = buildRegistry({
      models: [{ id: "stealth/pixel-canary", label: "Pixel Canary" }],
    });

    const created = await createSessionOnModel(registry, "stealth/pixel-canary");

    expect((await created.getRuntimeInfo()).model).toBe("stealth/pixel-canary");
  });

  test("keeps the agent's model when the requested model is neither advertised nor configured", async () => {
    const registry = buildRegistry({
      additionalModels: [{ id: "stealth/pixel-canary", label: "Pixel Canary" }],
    });

    const created = await createSessionOnModel(registry, "stale/removed-model");

    expect((await created.getRuntimeInfo()).model).toBe("advertised-default");
  });
});

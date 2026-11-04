import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { createDaemonTestContext, type DaemonTestContext } from "../test-utils/index.js";
import type { AgentSnapshotPayload, SessionOutboundMessage } from "../messages.js";

function tmpCwd(): string {
  return mkdtempSync(path.join(tmpdir(), "daemon-e2e-"));
}

function waitForAgentUpdate(
  messages: SessionOutboundMessage[],
  startIndex: number,
  predicate: (agent: AgentSnapshotPayload) => boolean,
  options?: { timeoutMs?: number },
): Promise<AgentSnapshotPayload> {
  const timeoutMs = options?.timeoutMs ?? 15000;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      clearInterval(interval);
      reject(new Error("Timeout waiting for agent_update"));
    }, timeoutMs);

    const interval = setInterval(() => {
      for (let i = startIndex; i < messages.length; i++) {
        const msg = messages[i];
        if (msg.type !== "agent_update") continue;
        if (msg.payload.kind !== "upsert") continue;
        if (predicate(msg.payload.agent)) {
          clearTimeout(timeout);
          clearInterval(interval);
          resolve(msg.payload.agent);
          return;
        }
      }
    }, 50);
  });
}

// The daemon only switches to a model the provider lists.
function pickModelSwitchPair(provider: string, models: Array<{ id: string }>): [string, string] {
  const [first, second] = Array.from(new Set(models.map((m) => m.id))).filter(Boolean);
  if (!first || !second) {
    throw new Error(`Provider ${provider} lists fewer than two models`);
  }
  return [first, second];
}

function pickThinkingSwitchOption(
  provider: string,
  models: Array<{
    thinkingOptions?: Array<{ id: string }>;
    defaultThinkingOptionId?: string;
  }>,
): { model: (typeof models)[number]; thinkingOptionId: string } {
  // The daemon only switches to a thinking option the model lists.
  const modelWithOptions = models.find((m) => (m.thinkingOptions?.length ?? 0) > 0);
  if (!modelWithOptions) {
    throw new Error(`No ${provider} model lists thinking options`);
  }

  const defaultThinkingId = modelWithOptions.defaultThinkingOptionId ?? "default";
  const thinkingOptionId =
    modelWithOptions.thinkingOptions?.find((o) => o.id !== defaultThinkingId)?.id ??
    modelWithOptions.thinkingOptions?.[0]?.id;
  if (!thinkingOptionId) {
    throw new Error(`No ${provider} thinking option found`);
  }
  return { model: modelWithOptions, thinkingOptionId };
}

let ctx: DaemonTestContext;
let messages: SessionOutboundMessage[] = [];
let unsubscribe: (() => void) | null = null;

beforeEach(async () => {
  ctx = await createDaemonTestContext();
  messages = [];
  unsubscribe = ctx.client.subscribeRawMessages((message) => {
    messages.push(message);
  });
  await ctx.client.fetchAgents({ subscribe: {} });
});

afterEach(async () => {
  unsubscribe?.();
  await ctx.cleanup();
}, 60000);

describe.each(["claude", "codex", "opencode"] as const)("live model switching (%s)", (provider) => {
  test("updates agent model without restarting", async () => {
    const cwd = tmpCwd();
    try {
      const modelList = await ctx.client.listProviderModels(provider);
      if (!modelList.models || modelList.models.length === 0) {
        throw new Error(`No models returned for provider ${provider}`);
      }
      const [modelA, modelB] = pickModelSwitchPair(provider, modelList.models);

      const agent = await ctx.client.createAgent({
        provider,
        cwd,
        title: `Model Switch (${provider})`,
        model: modelA,
      });

      const startIndex = messages.length;
      await ctx.client.setAgentModel(agent.id, modelB);

      const updated = await waitForAgentUpdate(
        messages,
        startIndex,
        (a) => a.id === agent.id && a.model === modelB,
        { timeoutMs: 20000 },
      );

      expect(updated.model).toBe(modelB);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 180000);
});

test("live thinking switching works for Claude (default -> non-default)", async () => {
  const cwd = tmpCwd();
  try {
    const modelList = await ctx.client.listProviderModels("claude");
    if (!modelList.models || modelList.models.length === 0) {
      throw new Error("No Claude models returned");
    }
    const { model, thinkingOptionId } = pickThinkingSwitchOption("Claude", modelList.models);

    const agent = await ctx.client.createAgent({
      provider: "claude",
      cwd,
      title: "Claude Thinking Switch",
      model: model.id,
    });

    const startIndex = messages.length;
    await ctx.client.setAgentThinkingOption(agent.id, thinkingOptionId);

    const updated = await waitForAgentUpdate(
      messages,
      startIndex,
      (a) => a.id === agent.id && a.thinkingOptionId === thinkingOptionId,
      { timeoutMs: 20000 },
    );

    expect(updated.thinkingOptionId).toBe(thinkingOptionId);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}, 120000);

test("live thinking switching works for Codex (default -> non-default)", async () => {
  const cwd = tmpCwd();
  try {
    const modelList = await ctx.client.listProviderModels("codex");
    if (!modelList.models || modelList.models.length === 0) {
      throw new Error("No Codex models returned");
    }

    const { model: modelWithOptions, thinkingOptionId } = pickThinkingSwitchOption(
      "Codex",
      modelList.models,
    );

    const agent = await ctx.client.createAgent({
      provider: "codex",
      cwd,
      title: "Codex Thinking Switch",
      model: modelWithOptions.id,
    });

    const startIndex = messages.length;
    await ctx.client.setAgentThinkingOption(agent.id, thinkingOptionId);

    const updated = await waitForAgentUpdate(
      messages,
      startIndex,
      (a) => a.id === agent.id && a.thinkingOptionId === thinkingOptionId,
      { timeoutMs: 20000 },
    );

    expect(updated.thinkingOptionId).toBe(thinkingOptionId);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}, 120000);

test("live thinking switching works for OpenCode", async () => {
  const cwd = tmpCwd();
  try {
    const modelList = await ctx.client.listProviderModels("opencode");
    if (!modelList.models || modelList.models.length === 0) {
      throw new Error("No OpenCode models returned");
    }

    const { model: modelWithThinkingOptions, thinkingOptionId } = pickThinkingSwitchOption(
      "OpenCode",
      modelList.models,
    );

    const agent = await ctx.client.createAgent({
      provider: "opencode",
      cwd,
      title: "OpenCode Preferences Switch",
      model: modelWithThinkingOptions.id,
    });

    const startIndex = messages.length;
    await ctx.client.setAgentThinkingOption(agent.id, thinkingOptionId);
    const updatedThinking = await waitForAgentUpdate(
      messages,
      startIndex,
      (a) => a.id === agent.id && a.thinkingOptionId === thinkingOptionId,
      { timeoutMs: 20000 },
    );
    expect(updatedThinking.thinkingOptionId).toBe(thinkingOptionId);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}, 180000);

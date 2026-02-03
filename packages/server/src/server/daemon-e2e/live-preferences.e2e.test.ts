import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import {
  createDaemonTestContext,
  type DaemonTestContext,
} from "../test-utils/index.js";
import type { AgentSnapshotPayload, SessionOutboundMessage } from "../messages.js";

function tmpCwd(): string {
  return mkdtempSync(path.join(tmpdir(), "daemon-e2e-"));
}

function waitForAgentUpdate(
  messages: SessionOutboundMessage[],
  startIndex: number,
  predicate: (agent: AgentSnapshotPayload) => boolean,
  options?: { timeoutMs?: number }
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

function pickTwoDistinctModels(models: Array<{ id: string }>): [string, string] {
  const ids = Array.from(new Set(models.map((m) => m.id))).filter(Boolean);
  if (ids.length < 2) {
    throw new Error(`Need at least 2 models to test switching; got ${ids.length}`);
  }
  return [ids[0]!, ids[1]!];
}

describe("daemon E2E", () => {
  let ctx: DaemonTestContext;
  let messages: SessionOutboundMessage[] = [];
  let unsubscribe: (() => void) | null = null;

  beforeEach(async () => {
    ctx = await createDaemonTestContext();
    messages = [];
    unsubscribe = ctx.client.subscribeRawMessages((message) => {
      messages.push(message);
    });
    ctx.client.subscribeAgentUpdates();
  });

  afterEach(async () => {
    unsubscribe?.();
    await ctx.cleanup();
  }, 60000);

  describe.each(["claude", "codex", "opencode"] as const)(
    "live model switching (%s)",
    (provider) => {
      test(
        "updates agent model without restarting",
        async () => {
          const cwd = tmpCwd();
          try {
            const modelList = await ctx.client.listProviderModels(provider);
            if (!modelList.models || modelList.models.length === 0) {
              throw new Error(`No models returned for provider ${provider}`);
            }
            const [modelA, modelB] = pickTwoDistinctModels(modelList.models);

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
              { timeoutMs: 20000 }
            );

            expect(updated.model).toBe(modelB);

            // Sanity: run a tiny prompt after switching.
            await ctx.client.sendMessage(agent.id, "Say 'ok' and nothing else");
            const final = await ctx.client.waitForFinish(agent.id, 120000);
            expect(final.status).toBe("idle");
          } finally {
            rmSync(cwd, { recursive: true, force: true });
          }
        },
        180000
      );
    }
  );

  test(
    "live thinking switching works for Claude (off -> max)",
    async () => {
      const cwd = tmpCwd();
      try {
        const modelList = await ctx.client.listProviderModels("claude");
        if (!modelList.models || modelList.models.length === 0) {
          throw new Error("No Claude models returned");
        }
        const modelId = modelList.models[0]!.id;

        const agent = await ctx.client.createAgent({
          provider: "claude",
          cwd,
          title: "Claude Thinking Switch",
          model: modelId,
        });

        const startIndex = messages.length;
        await ctx.client.setAgentThinkingOption(agent.id, "max");

        const updated = await waitForAgentUpdate(
          messages,
          startIndex,
          (a) => a.id === agent.id && a.thinkingOptionId === "max",
          { timeoutMs: 20000 }
        );

        expect(updated.thinkingOptionId).toBe("max");
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    },
    120000
  );

  test(
    "live thinking switching works for Codex (default -> non-default)",
    async () => {
      const cwd = tmpCwd();
      try {
        const modelList = await ctx.client.listProviderModels("codex");
        if (!modelList.models || modelList.models.length === 0) {
          throw new Error("No Codex models returned");
        }

        const modelWithOptions = modelList.models.find(
          (m) => (m.thinkingOptions?.length ?? 0) > 1
        );
        if (!modelWithOptions) {
          throw new Error("No Codex model with thinkingOptions returned");
        }
        const nonDefault =
          modelWithOptions.thinkingOptions?.find((o) => o.id !== "default")?.id ??
          null;
        if (!nonDefault) {
          throw new Error("No non-default Codex thinking option found");
        }

        const agent = await ctx.client.createAgent({
          provider: "codex",
          cwd,
          title: "Codex Thinking Switch",
          model: modelWithOptions.id,
        });

        const startIndex = messages.length;
        await ctx.client.setAgentThinkingOption(agent.id, nonDefault);

        const updated = await waitForAgentUpdate(
          messages,
          startIndex,
          (a) => a.id === agent.id && a.thinkingOptionId === nonDefault,
          { timeoutMs: 20000 }
        );

        expect(updated.thinkingOptionId).toBe(nonDefault);
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    },
    120000
  );

  test(
    "live thinking + variant switching works for OpenCode",
    async () => {
      const cwd = tmpCwd();
      try {
        const modelList = await ctx.client.listProviderModels("opencode");
        if (!modelList.models || modelList.models.length === 0) {
          throw new Error("No OpenCode models returned");
        }

        const modelWithVariants = modelList.models.find(
          (m) => (m.variantOptions?.length ?? 0) > 1
        );
        if (!modelWithVariants) {
          throw new Error("No OpenCode model with variantOptions returned");
        }

        const agent = await ctx.client.createAgent({
          provider: "opencode",
          cwd,
          title: "OpenCode Preferences Switch",
          model: modelWithVariants.id,
        });

        // 1) Thinking: pick a non-default thinking option if available.
        const thinkingId =
          modelWithVariants.thinkingOptions?.find((o) => o.id !== "default")?.id ??
          null;
        if (thinkingId) {
          const startIndex = messages.length;
          await ctx.client.setAgentThinkingOption(agent.id, thinkingId);
          const updatedThinking = await waitForAgentUpdate(
            messages,
            startIndex,
            (a) => a.id === agent.id && a.thinkingOptionId === thinkingId,
            { timeoutMs: 20000 }
          );
          expect(updatedThinking.thinkingOptionId).toBe(thinkingId);
        }

        // 2) Variant: clear thinking override (so variant takes effect), then set variant.
        await ctx.client.setAgentThinkingOption(agent.id, null);
        const variantId =
          modelWithVariants.variantOptions?.find((o) => o.id !== "default")?.id ??
          null;
        if (!variantId) {
          throw new Error("No non-default OpenCode variant found");
        }

        const startIndex2 = messages.length;
        await ctx.client.setAgentVariant(agent.id, variantId);

        const updatedVariant = await waitForAgentUpdate(
          messages,
          startIndex2,
          (a) => a.id === agent.id && a.variantId === variantId,
          { timeoutMs: 20000 }
        );

        expect(updatedVariant.variantId).toBe(variantId);
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    },
    180000
  );
});

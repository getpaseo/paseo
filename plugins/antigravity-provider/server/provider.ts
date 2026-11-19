import { runAcpProvider, type AcpTransformer } from "@getpaseo/plugin/server/acp";
import {
  PROVIDER_PROTOCOL_VERSION,
  type ProviderRegistration,
} from "@getpaseo/plugin/server/provider";
import { z } from "zod";

const legacySession = z.object({
  version: z.literal(1),
  data: z.object({ conversationId: z.string().min(1) }),
});
const systemPromptCapability = z.object({
  antigravity: z.object({ systemPrompt: z.object({ append: z.literal(true) }) }),
});

const fileWrite = z.object({ Path: z.string(), Content: z.string().optional() });

const antigravity: AcpTransformer = {
  toolCall(call) {
    if (call.name === "write_file") {
      const input = fileWrite.safeParse(call.input);
      if (input.success) {
        return {
          ...call,
          detail: { type: "write", filePath: input.data.Path, content: input.data.Content },
        };
      }
    }
    if (call.kind === "read" && call.locations[0]) {
      return { ...call, detail: { type: "read", filePath: call.locations[0] } };
    }
    return call;
  },
  sessionOpen({ persistence, systemPrompt, agentMetadata }) {
    // COMPAT(antigravityStreamJson): added in v0.16.2, remove after 2027-11-19.
    const saved = legacySession.safeParse(persistence);
    return {
      sessionId: saved.success ? saved.data.data.conversationId : undefined,
      metadata:
        systemPrompt && systemPromptCapability.safeParse(agentMetadata).success
          ? { antigravity: { systemPrompt: { append: systemPrompt } } }
          : undefined,
    };
  },
  async configure(change, { apply, catalog }) {
    // COMPAT(antigravityStreamJson): added in v0.16.2, remove after 2027-11-19.
    if (change.target === "model" && change.value) {
      const legacyModel = /^(.*)-(xhigh|high|medium|low|minimal)$/.exec(change.value);
      if (legacyModel) {
        const { models } = catalog();
        const [, model, effort] = legacyModel;
        if (
          !models.some((option) => option.id === change.value) &&
          models.some((option) => option.id === model)
        ) {
          await apply({ target: "model", value: model });
          if (catalog().thinkingOptions?.some((option) => option.id === effort)) {
            await apply({ target: "thinking", value: effort });
          }
          return "handled";
        }
      }
    }
    return "pass";
  },
};

export function createAntigravityProvider(): ProviderRegistration {
  const provider = runAcpProvider({
    id: "antigravity",
    label: "Antigravity",
    description: "Antigravity CLI on your host",
    icon: "icon.svg",
    command: ["agy", "acp", "--disable-telemetry"],
    acpOptions: {
      waitForInitialCommands: true,
      loadReplayQuietPeriodMs: 200,
      autoAcceptMode: {
        mode: {
          id: "full-access",
          label: "Full access",
          description: "Approve tool requests without asking.",
          icon: "ShieldOff",
          colorTier: "dangerous",
        },
        nativeMode: "default",
        default: true,
      },
    },
    transformers: [antigravity],
  });
  return {
    ...provider,
    async status({ launch }) {
      if (!launch) return { available: false, diagnostic: "Install Antigravity 1.5.0 or later." };
      try {
        const connection = await provider.connect({
          launch,
          versions: [PROVIDER_PROTOCOL_VERSION],
          capabilities: [],
        });
        await connection.close();
        return { available: true };
      } catch {
        return {
          available: false,
          diagnostic:
            "Antigravity ACP did not start. Install Antigravity 1.5.0 or later. If you override the command, include the acp subcommand.",
        };
      }
    },
  };
}

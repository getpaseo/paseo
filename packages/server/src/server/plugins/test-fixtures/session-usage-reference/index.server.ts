import type { PluginServerContext } from "@getpaseo/plugin/server";
import {
  negotiateProviderCapabilities,
  type ProviderEvent,
} from "@getpaseo/plugin/server/provider";
import { z } from "zod";

export default function contribute(server: PluginServerContext) {
  for (const id of ["claude", "codex", "copilot", "cursor", "kimi", "generic-acp"]) {
    let input = z.object({}).strict();
    if (id === "claude") input = z.object({ configDir: z.string() }).strict();
    if (id === "codex") input = z.object({ codexHome: z.string() }).strict();
    server.registerUsageSource({
      id,
      label: id,
      input,
      fetch: async () => ({
        account: { key: "default" },
        status: "available",
        windows: [{ id: "hour", label: "Hour", usedPct: 31, headline: true }],
      }),
    });
  }
  server.registerUsageSource({
    id: "fixture-session-usage",
    label: "Fixture session usage",
    input: z.object({ account: z.string() }).strict(),
    fetch: async (input) => ({
      account: { key: (input as { account: string }).account },
      status: "available",
      windows: [{ id: "hour", label: "Hour", usedPct: 31, headline: true }],
    }),
  });
  server.registerProvider({
    id: "fixture-session-provider",
    label: "Fixture session provider",
    async connect(request) {
      const capabilities = negotiateProviderCapabilities(request.capabilities, [
        "prompt.message",
        "session.usage_reference",
      ]);
      const listeners = new Set<(event: ProviderEvent) => void>();
      const models = new Map<string, string | undefined>();
      const emit = (event: ProviderEvent) => {
        for (const listener of listeners) listener(event);
      };
      return {
        version: 1,
        capabilities,
        async send(input) {
          if (input.type === "catalog")
            emit({
              type: "catalog",
              requestId: input.requestId,
              catalog: {
                models: [
                  { id: "fixture", label: "Fixture" },
                  { id: "missing", label: "Missing" },
                ],
                modes: [],
              },
            });
          if (input.type === "session.open") {
            models.set(input.sessionId, input.config.model);
            emit({
              type: "session.opened",
              requestId: input.requestId,
              sessionId: input.sessionId,
              capabilities,
              restoration: "core",
              cwd: input.config.cwd,
            });
            emit({ type: "session.ready", requestId: input.requestId, sessionId: input.sessionId });
          }
          if (input.type === "session.usage_reference")
            emit({
              type: "usage_reference",
              requestId: input.requestId,
              reference: {
                source:
                  models.get(input.sessionId) === "missing"
                    ? "missing-source"
                    : "fixture-session-usage",
                input: { account: "from-session" },
              },
            });
          if (input.type === "session.close")
            emit({ type: "request.completed", requestId: input.requestId });
        },
        onEvent(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        async close() {
          listeners.clear();
        },
      };
    },
  });
  return () => {};
}

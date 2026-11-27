import { describe, expect, it } from "vitest";
import type {
  AgentPersistenceHandle,
  AgentSession,
  AgentSessionConfig,
  ImportProviderSessionContext,
} from "./agent-sdk-types.js";
import { importSessionFromPersistence } from "./provider-session-import.js";

const SESSION_FILE = "/Users/dev/.omp/agent/sessions/project/2026-01-01_session-id.jsonl";
const SESSION_ID = "session-id";

function config(cwd: string): AgentSessionConfig {
  return { provider: "omp", cwd };
}

function context(cwd: string): ImportProviderSessionContext {
  return { config: config(cwd), storedConfig: config(cwd) };
}

function fakeSession(described: AgentPersistenceHandle | null): AgentSession {
  return {
    async *streamHistory() {},
    describePersistence: () => described,
  } as unknown as AgentSession;
}

describe("importSessionFromPersistence", () => {
  it("persists the resumed session identity instead of the listed file handle", async () => {
    const cwd = "/Users/dev/code/project";
    const imported = await importSessionFromPersistence({
      provider: "omp",
      request: { providerHandleId: SESSION_FILE, cwd },
      context: context(cwd),
      resumeSession: async () =>
        fakeSession({
          provider: "omp",
          sessionId: SESSION_ID,
          nativeHandle: SESSION_FILE,
          metadata: { cwd, model: "resumed-model" },
        }),
    });

    expect(imported.persistence).toMatchObject({
      provider: "omp",
      sessionId: SESSION_ID,
      nativeHandle: SESSION_FILE,
      metadata: { cwd, provider: "omp", model: "resumed-model" },
    });
  });

  it("keeps the requested handle when the provider describes no identity", async () => {
    const cwd = "/Users/dev/code/project";
    const imported = await importSessionFromPersistence({
      provider: "omp",
      request: { providerHandleId: SESSION_FILE, cwd },
      context: context(cwd),
      resumeSession: async () => fakeSession(null),
    });

    expect(imported.persistence).toMatchObject({
      provider: "omp",
      sessionId: SESSION_FILE,
      nativeHandle: SESSION_FILE,
    });
  });

  it("keeps the stats the provider reports in its history", async () => {
    const cwd = "/Users/dev/code/project";
    const imported = await importSessionFromPersistence({
      provider: "omp",
      request: { providerHandleId: SESSION_FILE, cwd },
      context: context(cwd),
      resumeSession: async () =>
        ({
          async *streamHistory() {
            yield { type: "timeline", provider: "omp", item: { type: "user_message", text: "Hi" } };
            yield {
              type: "timeline",
              provider: "omp",
              item: { type: "assistant_message", text: "Done" },
            };
            yield {
              type: "turn_completed",
              provider: "omp",
              metrics: [{ label: "Elapsed", value: "1.2s" }],
            };
            yield {
              type: "session_metrics_updated",
              provider: "omp",
              metrics: [{ label: "Cost", value: "$0.011" }],
            };
          },
          describePersistence: () => null,
        }) as unknown as AgentSession,
    });

    expect(imported.timeline.map((entry) => entry.turnMetrics ?? null)).toEqual([
      null,
      [{ label: "Elapsed", value: "1.2s" }],
    ]);
    expect(imported.sessionMetrics).toEqual([{ label: "Cost", value: "$0.011" }]);
  });
});

import { describe, expect, test } from "vitest";

import pino from "pino";

import { PiCliRuntime } from "./cli-runtime.js";

describe("OMP integration", () => {
  function createOmpRuntime(): PiCliRuntime {
    return new PiCliRuntime({
      logger: pino({ level: "silent" }),
      command: ["omp"],
      commandsRpcType: "get_available_commands",
    });
  }

  test("OMP responds to get_session_stats via real process", async () => {
    const runtime = createOmpRuntime();
    const session = await runtime.startSession({ cwd: "/tmp" });

    try {
      const stats = (await session.getSessionStats()) as Record<string, unknown>;

      expect(stats).toHaveProperty("tokens");
      expect(stats).toHaveProperty("cost");
      expect((stats.tokens as Record<string, unknown>)!).toHaveProperty("input");
      expect((stats.tokens as Record<string, unknown>)!).toHaveProperty("output");
    } finally {
      await session.close();
    }
  }, 15_000);

  test("OMP supports get_state RPC and returns model info", async () => {
    const runtime = createOmpRuntime();
    const session = await runtime.startSession({ cwd: "/tmp" });

    try {
      const state = (await session.getState()) as unknown as Record<string, unknown>;

      // OMP returns model info even before a turn starts.
      expect(state).toHaveProperty("model");
    } finally {
      await session.close();
    }
  }, 15_000);

  test("get_session_stats data shape matches Pi schema expectations", async () => {
    const runtime = createOmpRuntime();
    const session = await runtime.startSession({ cwd: "/tmp" });

    try {
      const stats = (await session.getSessionStats()) as Record<string, unknown>;

      // toAgentUsage reads these fields — verify they exist in OMP response.
      expect((stats.tokens as Record<string, unknown>)!).toHaveProperty("input");
      expect((stats.tokens as Record<string, unknown>)!).toHaveProperty("output");
      expect(stats.cost).toBeDefined();

      // contextUsage is optional but may be present; assert its shape when present.
      if ("contextUsage" in stats) {
        const cu = stats.contextUsage as Record<string, unknown>;
        expect(cu!).toMatchObject({
          tokens: expect.any(Object),
          contextWindow: expect.any(Number),
        });
      }
    } finally {
      await session.close();
    }
  }, 15_000);
});

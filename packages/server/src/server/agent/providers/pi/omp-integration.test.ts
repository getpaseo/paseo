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
      // Verify OMP returns valid stats shape.
      const stats = await session.getSessionStats();

      expect(stats).toBeDefined();
      if (typeof stats === "object" && stats !== null) {
        expect(stats).toHaveProperty("tokens");
        expect(stats).toHaveProperty("cost");

        const tokens = stats.tokens as Record<string, unknown> | undefined;
        if (tokens && typeof tokens === "object") {
          expect(tokens).toHaveProperty("input");
          expect(tokens).toHaveProperty("output");
        }
      }
    } finally {
      await session.close();
    }
  }, 15_000);

  test("OMP supports get_state RPC and returns model info", async () => {
    const runtime = createOmpRuntime();
    const session = await runtime.startSession({ cwd: "/tmp" });

    try {
      const state = await session.getState();

      expect(state).toBeDefined();
      if (typeof state === "object" && state !== null) {
        // OMP returns model info even before a turn starts.
        expect(state).toHaveProperty("model");
      }
    } finally {
      await session.close();
    }
  }, 15_000);

  test("get_session_stats data shape matches Pi schema expectations", async () => {
    const runtime = createOmpRuntime();
    const session = await runtime.startSession({ cwd: "/tmp" });

    try {
      const stats = await session.getSessionStats();

      // toAgentUsage reads these fields — verify they exist in OMP response.
      const tokens = stats.tokens as Record<string, unknown> | undefined;
      expect(tokens?.input).toBeDefined();
      expect(tokens?.output).toBeDefined();
      expect(stats.cost).toBeDefined();

      // contextUsage is optional but may be present.
      if ("contextUsage" in stats) {
        const cu = stats.contextUsage as Record<string, unknown> | undefined;
        if (cu && typeof cu === "object") {
          expect(cu).toHaveProperty("tokens");
          expect(cu).toHaveProperty("contextWindow");
        }
      }
    } finally {
      await session.close();
    }
  }, 15_000);
});

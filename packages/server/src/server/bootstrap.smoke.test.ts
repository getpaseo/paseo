import { describe, expect, test } from "vitest";

import { createTestPaseoDaemon } from "./test-utils/paseo-daemon.js";

describe("paseo daemon bootstrap", () => {
  test("starts and serves health endpoint", async () => {
    const daemonHandle = await createTestPaseoDaemon();
    try {
      const response = await fetch(
        `http://127.0.0.1:${daemonHandle.port}/api/health`,
        {
          headers: daemonHandle.agentMcpAuthHeader
            ? { Authorization: daemonHandle.agentMcpAuthHeader }
            : undefined,
        }
      );
      expect(response.ok).toBe(true);
      const payload = await response.json();
      expect(payload.status).toBe("ok");
      expect(typeof payload.timestamp).toBe("string");
    } finally {
      await daemonHandle.close();
    }
  });
});

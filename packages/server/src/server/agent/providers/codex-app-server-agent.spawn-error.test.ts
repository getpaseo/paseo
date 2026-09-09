import { describe, expect, test, vi } from "vitest";

import { CodexAppServerAgentClient } from "./codex-app-server-agent.js";
import { runProviderRefreshWithDeadline } from "../provider-refresh-deadline.js";
import { createTestLogger } from "../../../test-utils/test-logger.js";
import { createCodexAppServerChildProcess } from "./codex/test-utils/fake-app-server.js";

describe("CodexAppServerAgentClient spawn error handling", () => {
  const logger = createTestLogger();

  test("fetchCatalog rejects gracefully when the codex binary does not exist", async () => {
    const client = new CodexAppServerAgentClient(logger, {
      command: {
        mode: "replace",
        argv: ["/nonexistent/codex-binary-that-does-not-exist"],
      },
    });

    const uncaughtErrors: unknown[] = [];
    const onUncaught = (err: unknown) => {
      uncaughtErrors.push(err);
    };
    process.on("uncaughtException", onUncaught);

    try {
      await expect(
        client.fetchCatalog({ scope: "workspace", cwd: "/tmp/codex-models", force: false }),
      ).rejects.toThrow();
      // Drain microtask queue to ensure no deferred uncaught errors
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(uncaughtErrors).toHaveLength(0);
    } finally {
      process.off("uncaughtException", onUncaught);
    }
  });

  test("fetchCatalog settles when the refresh deadline aborts an unanswered initialize", async () => {
    const client = new CodexAppServerAgentClient(logger, {
      command: {
        mode: "replace",
        argv: ["/nonexistent/codex-binary-that-does-not-exist"],
      },
    });
    const child = createCodexAppServerChildProcess();
    const kill = vi.spyOn(child, "kill");
    Object.assign(client, { spawnAppServer: async () => child });

    await expect(
      runProviderRefreshWithDeadline({
        label: "Codex",
        timeoutMs: 50,
        operation: (context) =>
          client.fetchCatalog(
            { scope: "workspace", cwd: "/tmp/codex-models", force: false },
            context,
          ),
      }),
    ).rejects.toThrow("Timed out refreshing Codex after 50ms");
    expect(kill).toHaveBeenCalled();
  });

  test("listImportableSessions rejects gracefully when the codex binary does not exist", async () => {
    const client = new CodexAppServerAgentClient(logger, {
      command: {
        mode: "replace",
        argv: ["/nonexistent/codex-binary-that-does-not-exist"],
      },
    });

    const uncaughtErrors: unknown[] = [];
    const onUncaught = (err: unknown) => {
      uncaughtErrors.push(err);
    };
    process.on("uncaughtException", onUncaught);

    try {
      await expect(client.listImportableSessions()).rejects.toThrow();
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(uncaughtErrors).toHaveLength(0);
    } finally {
      process.off("uncaughtException", onUncaught);
    }
  });
});

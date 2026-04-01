import { describe, test, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";

import { OpenCodeAgentClient } from "./opencode-agent.js";
import { isProviderAvailable } from "../../daemon-e2e/agent-configs.js";
import type { AgentStreamEvent } from "../agent-sdk-types.js";

describe("OpenCode assistant message", () => {
  test.runIf(isProviderAvailable("opencode"))(
    "assistant_message appears in live stream with opencode/big-pickle",
    async () => {
      const cwd = mkdtempSync(path.join(tmpdir(), "opencode-msg-"));
      const logger = pino({ level: "silent" });
      const client = new OpenCodeAgentClient(logger);

      try {
        const session = await client.createSession({
          provider: "opencode",
          cwd,
          model: "opencode/big-pickle",
          modeId: "build",
        });

        const result = await session.run("Say hello back in one sentence.");

        const assistantItems = result.timeline.filter(
          (item) => item.type === "assistant_message",
        );
        expect(assistantItems.length).toBeGreaterThan(0);
        expect(result.finalText.length).toBeGreaterThan(0);
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    },
    60_000,
  );

  test.runIf(isProviderAvailable("opencode"))(
    "streamHistory returns assistant_message after a completed turn",
    async () => {
      const cwd = mkdtempSync(path.join(tmpdir(), "opencode-history-"));
      const logger = pino({ level: "silent" });
      const client = new OpenCodeAgentClient(logger);

      try {
        const session = await client.createSession({
          provider: "opencode",
          cwd,
        });

        const result = await session.run("Say hello back in one sentence.");
        expect(result.timeline.some((item) => item.type === "assistant_message")).toBe(true);

        const historyEvents: AgentStreamEvent[] = [];
        for await (const event of session.streamHistory()) {
          historyEvents.push(event);
        }

        const historyAssistant = historyEvents.filter(
          (e) => e.type === "timeline" && e.item.type === "assistant_message",
        );
        expect(historyAssistant.length).toBeGreaterThan(0);
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    },
    60_000,
  );

});

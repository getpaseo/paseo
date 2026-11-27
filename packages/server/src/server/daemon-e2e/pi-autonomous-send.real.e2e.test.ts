import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeAll, beforeEach, expect, test } from "vitest";
import pino from "pino";

import type { AgentTimelineItem } from "../agent/agent-sdk-types.js";
import { PiRpcAgentClient } from "../agent/providers/pi/agent.js";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { createTestPaseoDaemon } from "../test-utils/paseo-daemon.js";
import {
  canRunRealProvider,
  getRealProviderConfig,
  getRealProviderRuntimeSettings,
} from "./real-provider-test-config.js";

process.env.PASEO_SUPERVISED = "0";

const TIMEOUT_MS = 240_000;
const MODEL = getRealProviderConfig("pi").model;

// Like a background-shell extension, this starts a Pi run on its own after the first run
// settles. Its before_agent_start hook keeps Pi busy before Pi reports agent_start, so the
// daemon still sees the agent as idle.
function backgroundExtension(startedMarker: string): string {
  return `
import { writeFileSync } from "node:fs";
export default function (pi) {
  let fired = false;
  pi.on("before_agent_start", async (event) => {
    if (event.messageType !== "custom") return;
    writeFileSync(${JSON.stringify(startedMarker)}, "started");
    await new Promise((resolve) => setTimeout(resolve, 4000));
  });
  pi.on("agent_settled", async () => {
    if (fired) return;
    fired = true;
    setTimeout(() => {
      pi.sendMessage(
        { customType: "background-result", content: "Background job finished. Reply BG_ACK.", display: true },
        { triggerTurn: true },
      );
    }, 500);
  });
}
`;
}

let canRun = false;
beforeAll(async () => {
  canRun = await canRunRealProvider("pi");
});
beforeEach((context) => {
  if (!canRun) context.skip();
});

async function waitForFile(file: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(file)) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${file}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

test(
  "real Pi daemon delivers a steer sent before Pi reports a run it started itself",
  async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "pi-autonomous-send-"));
    const extensionPath = path.join(cwd, "background.ts");
    const startedMarker = path.join(cwd, "background-run-started");
    writeFileSync(extensionPath, backgroundExtension(startedMarker));
    const logger = pino({ level: "silent" });
    const daemon = await createTestPaseoDaemon({
      agentClients: {
        pi: new PiRpcAgentClient({
          logger,
          runtimeSettings: {
            ...getRealProviderRuntimeSettings("pi"),
            command: {
              mode: "replace",
              argv: ["pi", "--extension", extensionPath],
            },
          },
        }),
      },
      logger,
    });
    const client = new DaemonClient({
      url: `ws://127.0.0.1:${daemon.port}/ws`,
      appVersion: "0.1.45",
    });
    const failures: string[] = [];
    try {
      await client.connect();
      await client.fetchAgents({ subscribe: {} });
      const agent = await client.createAgent({
        cwd,
        title: "pi-autonomous-send",
        provider: "pi",
        model: MODEL,
      });
      daemon.daemon.agentManager.subscribe((event) => {
        if (event.type === "agent_stream" && event.event.type === "turn_failed") {
          failures.push(event.event.error);
        }
      });

      await client.sendMessage(agent.id, "Reply with exactly: FIRST_ACK");
      await client.waitForFinish(agent.id, TIMEOUT_MS);
      await waitForFile(startedMarker, 30_000);
      expect(readFileSync(startedMarker, "utf8")).toBe("started");

      await client.sendMessage(agent.id, "Also reply with exactly: SECOND_ACK", {
        activeTurnBehavior: "steer",
      });
      await client.waitForFinish(agent.id, TIMEOUT_MS);

      const timeline = await client.fetchAgentTimeline(agent.id, {
        direction: "tail",
        limit: 0,
        projection: "canonical",
      });
      const replies = timeline.entries
        .map((entry) => entry.item)
        .filter(
          (item): item is Extract<AgentTimelineItem, { type: "assistant_message" }> =>
            item.type === "assistant_message",
        )
        .map((item) => item.text)
        .join("\n");
      expect(failures).toEqual([]);
      expect(replies).toContain("SECOND_ACK");
    } finally {
      await client.close().catch(() => undefined);
      await daemon.close().catch(() => undefined);
      rmSync(cwd, { recursive: true, force: true });
    }
  },
  TIMEOUT_MS * 2,
);

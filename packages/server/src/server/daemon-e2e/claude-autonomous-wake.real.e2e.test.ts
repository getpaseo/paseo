import { describe, expect, test } from "vitest";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";
import WebSocket from "ws";

import { createTestJunctionDaemon } from "../test-utils/junction-daemon.js";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { ClaudeAgentClient } from "../agent/providers/claude-agent.js";
import { getFullAccessConfig } from "./agent-configs.js";
import { isCommandAvailable } from "../agent/provider-launch-config.js";

function tmpCwd(): string {
  return mkdtempSync(path.join(tmpdir(), "daemon-real-claude-autonomous-wake-"));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const BACKGROUND_TASK_SLEEP_5_PROMPT = [
  "Use the Task tool (not a Bash background process).",
  "Start a background task that runs exactly: sleep 5",
  "Do not wait for the task result.",
  "Immediately reply with exactly: SPAWNED",
].join(" ");
const BACKGROUND_TASK_SLEEP_5_REPEAT_PROMPT = `do it again: ${BACKGROUND_TASK_SLEEP_5_PROMPT}`;

function sanitizeClaudeProjectPath(cwd: string): string {
  return cwd.replace(/[\\/\.]/g, "-").replace(/_/g, "-");
}

function resolveClaudeTranscriptPath(params: {
  cwd: string;
  sessionId: string;
}): string {
  const configDir = process.env.CLAUDE_CONFIG_DIR ?? path.join(homedir(), ".claude");
  const cwdCandidates = [params.cwd];
  try {
    const realpath = realpathSync(params.cwd);
    if (!cwdCandidates.includes(realpath)) {
      cwdCandidates.push(realpath);
    }
  } catch {
    // ignore realpath errors for temporary cwd teardown races
  }

  for (const cwd of cwdCandidates) {
    const candidate = path.join(
      configDir,
      "projects",
      sanitizeClaudeProjectPath(cwd),
      `${params.sessionId}.jsonl`
    );
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return path.join(
    configDir,
    "projects",
    sanitizeClaudeProjectPath(params.cwd),
    `${params.sessionId}.jsonl`
  );
}

type ClaudeTranscriptLine = {
  type?: unknown;
  timestamp?: unknown;
  uuid?: unknown;
  parentUuid?: unknown;
  message?: { content?: unknown } | null;
};

function readTranscriptLines(pathname: string): ClaudeTranscriptLine[] {
  if (!existsSync(pathname)) {
    return [];
  }
  const text = readFileSync(pathname, "utf8");
  const rows: ClaudeTranscriptLine[] = [];
  for (const line of text.split(/\n+/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      rows.push(JSON.parse(trimmed) as ClaudeTranscriptLine);
    } catch {
      // ignore malformed rows while transcript is still being appended
    }
  }
  return rows;
}

function readUserText(line: ClaudeTranscriptLine): string {
  const content = line.message?.content;
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((chunk) => {
      if (!chunk || typeof chunk !== "object") {
        return "";
      }
      const text = (chunk as { text?: unknown }).text;
      if (typeof text === "string") {
        return text;
      }
      const nested = (chunk as { content?: unknown }).content;
      return typeof nested === "string" ? nested : "";
    })
    .join(" ")
    .trim();
}

function readAssistantText(line: ClaudeTranscriptLine): string {
  const content = line.message?.content;
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((chunk) => {
      if (!chunk || typeof chunk !== "object") {
        return "";
      }
      const text = (chunk as { text?: unknown }).text;
      if (typeof text === "string") {
        return text;
      }
      return "";
    })
    .join("")
    .trim();
}

function readAssistantModel(line: ClaudeTranscriptLine): string {
  const message = line.message as
    | {
        model?: unknown;
      }
    | null
    | undefined;
  if (!message || typeof message !== "object") {
    return "";
  }
  return typeof message.model === "string" ? message.model : "";
}

function parseTimestamp(line: ClaudeTranscriptLine): number {
  const timestamp = line.timestamp;
  if (typeof timestamp !== "string") {
    return 0;
  }
  const parsed = Date.parse(timestamp);
  return Number.isFinite(parsed) ? parsed : 0;
}

type TranscriptRaceEvidence = {
  helloAssistantText: string;
  notificationOutcomeAssistantText: string;
};

function extractTranscriptRaceEvidence(
  lines: ClaudeTranscriptLine[]
): TranscriptRaceEvidence | null {
  const userLines = lines.filter((line) => line.type === "user");
  const assistantLines = lines.filter((line) => line.type === "assistant");
  const doItAgain = [...userLines]
    .reverse()
    .find((line) => readUserText(line).toLowerCase().includes("do it again"));
  const isHelloPrompt = (line: ClaudeTranscriptLine): boolean => {
    const text = readUserText(line).trim().toLowerCase();
    return text === "hello" || text === "say exactly hello";
  };
  const helloUser = [...userLines]
    .reverse()
    .find((line) => isHelloPrompt(line));

  if (!doItAgain || !helloUser || typeof helloUser.uuid !== "string") {
    return null;
  }

  const helloAssistant = assistantLines.find(
    (line) =>
      typeof line.parentUuid === "string" &&
      line.parentUuid === helloUser.uuid &&
      readAssistantText(line).length > 0
  );
  if (!helloAssistant) {
    return null;
  }

  const doItAgainTs = parseTimestamp(doItAgain);
  const helloTs = parseTimestamp(helloUser);
  const taskNotificationCandidates = userLines.filter((line) => {
    const lineTs = parseTimestamp(line);
    if (lineTs <= doItAgainTs) {
      return false;
    }
    return readUserText(line).includes("<task-notification>");
  });
  const taskNotificationUser = [...taskNotificationCandidates]
    .reverse()
    .find((line) => parseTimestamp(line) >= helloTs) ?? taskNotificationCandidates[0];
  if (!taskNotificationUser || typeof taskNotificationUser.uuid !== "string") {
    return null;
  }
  const helloAssistantUuid =
    typeof helloAssistant.uuid === "string" ? helloAssistant.uuid : null;
  const taskNotificationTs = parseTimestamp(taskNotificationUser);
  const sortedAssistantLines = [...assistantLines].sort(
    (a, b) => parseTimestamp(a) - parseTimestamp(b)
  );
  const byTaskNotificationParent = sortedAssistantLines.find((line) => {
    const lineTs = parseTimestamp(line);
    if (lineTs < taskNotificationTs) {
      return false;
    }
    if (line.parentUuid !== taskNotificationUser.uuid) {
      return false;
    }
    if (readAssistantModel(line) === "<synthetic>") {
      return false;
    }
    return readAssistantText(line).length > 0;
  });
  const notificationOutcomeAssistant = byTaskNotificationParent ??
    sortedAssistantLines.find((line) => {
      const lineTs = parseTimestamp(line);
      if (lineTs < taskNotificationTs) {
        return false;
      }
      const lineUuid = typeof line.uuid === "string" ? line.uuid : null;
      if (helloAssistantUuid && lineUuid === helloAssistantUuid) {
        return false;
      }
      if (readAssistantModel(line) === "<synthetic>") {
        return false;
      }
      return readAssistantText(line).length > 0;
    });
  if (!notificationOutcomeAssistant) {
    return null;
  }

  return {
    helloAssistantText: readAssistantText(helloAssistant),
    notificationOutcomeAssistantText: readAssistantText(notificationOutcomeAssistant),
  };
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

function compactText(value: string): string {
  return normalizeText(value).replace(/\s+/g, "");
}

function summarizeTranscriptTail(lines: ClaudeTranscriptLine[], limit = 14): string {
  const tail = lines.slice(-limit);
  return tail
    .map((line) => {
      const ts = typeof line.timestamp === "string" ? line.timestamp : "";
      const type = typeof line.type === "string" ? line.type : "unknown";
      if (type === "user") {
        return `${ts} user ${readUserText(line).slice(0, 160)}`;
      }
      if (type === "assistant") {
        return `${ts} assistant ${readAssistantText(line).slice(0, 160)}`;
      }
      if (type === "queue-operation") {
        const op = (line as { operation?: unknown }).operation;
        const content = (line as { content?: unknown }).content;
        return `${ts} queue ${typeof op === "string" ? op : "unknown"} ${typeof content === "string" ? content.slice(0, 120) : ""}`;
      }
      return `${ts} ${type}`;
    })
    .join("\n");
}

async function runPreHelloNoise(params: {
  wsUrl: string;
  durationMs: number;
}): Promise<void> {
  const deadline = Date.now() + params.durationMs;
  while (Date.now() < deadline) {
    await new Promise<void>((resolve) => {
      const ws = new WebSocket(params.wsUrl);
      const fallback = setTimeout(() => {
        try {
          ws.close();
        } catch {
          // ignore
        }
        resolve();
      }, 250);

      ws.once("open", () => {
        try {
          // Intentionally send a session message before hello to create the same
          // pre-hello churn seen in production logs.
          ws.send(
            JSON.stringify({
              type: "session",
              payload: {
                type: "fetch_agents_request",
                requestId: `noise-${Date.now()}`,
              },
            })
          );
        } catch {
          // ignore
        }
        setTimeout(() => {
          try {
            ws.close();
          } catch {
            // ignore
          }
        }, 5);
      });

      ws.once("close", () => {
        clearTimeout(fallback);
        resolve();
      });
      ws.once("error", () => {
        clearTimeout(fallback);
        resolve();
      });
    });
  }
}

function summarizeTimelineEntry(entry: {
  item:
    | { type: "user_message"; text: string }
    | { type: "assistant_message"; text: string }
    | { type: "tool_call"; name: string; status: string }
    | { type: string };
}): string {
  const item = entry.item;
  if (item.type === "user_message") {
    return `[user] ${item.text}`;
  }
  if (item.type === "assistant_message") {
    return `[assistant] ${item.text}`;
  }
  if (item.type === "tool_call") {
    return `[tool:${item.name}:${item.status}]`;
  }
  return `[${item.type}]`;
}

describe("daemon E2E (real claude) - autonomous wake from background task", () => {
  test.runIf(isCommandAvailable("claude"))(
    "A: background sleep returns idle, then wakes autonomously and appends timeline activity",
    async () => {
      const logger = pino({ level: "silent" });
      const cwd = tmpCwd();
      const daemon = await createTestJunctionDaemon({
        agentClients: { claude: new ClaudeAgentClient({ logger }) },
        logger,
      });
      const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });

      try {
        await client.connect();
        await client.fetchAgents({
          subscribe: { subscriptionId: "claude-autonomous-abc-a" },
        });

        const agent = await client.createAgent({
          cwd,
          title: "claude-autonomous-abc-a",
          ...getFullAccessConfig("claude"),
        });

        const autonomousWakeToken = `AUTONOMOUS_WAKE_${Date.now().toString(36)}`;
        await client.sendMessage(
          agent.id,
          [
            BACKGROUND_TASK_SLEEP_5_PROMPT,
            `When you later receive the task completion notification, reply with exactly: ${autonomousWakeToken}`,
          ].join(" ")
        );
        const firstFinish = await client.waitForFinish(agent.id, 240_000);
        expect(firstFinish.status).toBe("idle");

        const timelineAtIdle = await client.fetchAgentTimeline(agent.id, {
          direction: "tail",
          limit: 0,
          projection: "canonical",
        });

        await client.waitForAgentUpsert(
          agent.id,
          (snapshot) => snapshot.status === "running",
          30_000
        );

        const autonomousFinish = await client.waitForFinish(agent.id, 120_000);
        expect(autonomousFinish.status).toBe("idle");

        const timelineAfterWake = await client.fetchAgentTimeline(agent.id, {
          direction: "tail",
          limit: 0,
          projection: "canonical",
        });
        expect(timelineAfterWake.entries.length).toBeGreaterThanOrEqual(
          timelineAtIdle.entries.length
        );
        let sawTimelineGrowth =
          timelineAfterWake.entries.length > timelineAtIdle.entries.length;
        const growthDeadline = Date.now() + 20_000;
        while (!sawTimelineGrowth && Date.now() < growthDeadline) {
          await sleep(250);
          const nextTimeline = await client.fetchAgentTimeline(agent.id, {
            direction: "tail",
            limit: 0,
            projection: "canonical",
          });
          sawTimelineGrowth =
            nextTimeline.entries.length > timelineAtIdle.entries.length;
        }
        expect(sawTimelineGrowth).toBe(true);
      } finally {
        await client.close();
        await daemon.close();
        rmSync(cwd, { recursive: true, force: true });
      }
    },
    420_000
  );

  test.runIf(isCommandAvailable("claude"))(
    "B: immediate HELLO before task notification returns promptly without deadlock",
    async () => {
      const logger = pino({ level: "silent" });
      const cwd = tmpCwd();
      const daemon = await createTestJunctionDaemon({
        agentClients: { claude: new ClaudeAgentClient({ logger }) },
        logger,
      });
      const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });

      try {
        await client.connect();
        await client.fetchAgents({
          subscribe: { subscriptionId: "claude-autonomous-abc-b" },
        });

        const agent = await client.createAgent({
          cwd,
          title: "claude-autonomous-abc-b",
          ...getFullAccessConfig("claude"),
        });

        await client.sendMessage(agent.id, BACKGROUND_TASK_SLEEP_5_PROMPT);
        const kickoffFinish = await client.waitForFinish(agent.id, 240_000);
        expect(kickoffFinish.status).toBe("idle");

        await client.sendMessage(agent.id, "say exactly HELLO");
        const helloFinish = await client.waitForFinish(agent.id, 180_000);
        expect(helloFinish.status).toBe("idle");
        expect((helloFinish.lastMessage ?? "").trim().toUpperCase()).toContain("HELLO");

        await client.waitForAgentUpsert(
          agent.id,
          (snapshot) => snapshot.status === "running",
          30_000
        );
        const autonomousFinish = await client.waitForFinish(agent.id, 120_000);
        expect(autonomousFinish.status).toBe("idle");
      } finally {
        await client.close();
        await daemon.close();
        rmSync(cwd, { recursive: true, force: true });
      }
    },
    420_000
  );

  test.runIf(isCommandAvailable("claude"))(
    "C: interrupt during overlap returns quickly and does not leave agent stuck running",
    async () => {
      const logger = pino({ level: "silent" });
      const cwd = tmpCwd();
      const daemon = await createTestJunctionDaemon({
        agentClients: { claude: new ClaudeAgentClient({ logger }) },
        logger,
      });
      const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });

      try {
        await client.connect();
        await client.fetchAgents({
          subscribe: { subscriptionId: "claude-autonomous-abc-c" },
        });

        const agent = await client.createAgent({
          cwd,
          title: "claude-autonomous-abc-c",
          ...getFullAccessConfig("claude"),
        });

        await client.sendMessage(agent.id, BACKGROUND_TASK_SLEEP_5_PROMPT);
        const firstKickoff = await client.waitForFinish(agent.id, 240_000);
        expect(firstKickoff.status).toBe("idle");
        await client.waitForAgentUpsert(
          agent.id,
          (snapshot) => snapshot.status === "running",
          30_000
        );
        const firstAutonomousFinish = await client.waitForFinish(agent.id, 120_000);
        expect(firstAutonomousFinish.status).toBe("idle");

        await client.sendMessage(agent.id, BACKGROUND_TASK_SLEEP_5_REPEAT_PROMPT);
        const secondKickoff = await client.waitForFinish(agent.id, 240_000);
        expect(secondKickoff.status).toBe("idle");

        await client.sendMessage(agent.id, "say exactly HELLO");
        const helloFinish = await client.waitForFinish(agent.id, 180_000);
        expect(helloFinish.status).toBe("idle");

        await client.waitForAgentUpsert(
          agent.id,
          (snapshot) => snapshot.status === "running",
          30_000
        );

        const startedAt = Date.now();
        await client.cancelAgent(agent.id);
        const interruptDurationMs = Date.now() - startedAt;
        expect(interruptDurationMs).toBeLessThan(10_000);

        const settled = await client.waitForFinish(agent.id, 20_000);
        expect(settled.status).toBe("idle");
        const finalResult = await client.fetchAgent(agent.id);
        expect(finalResult?.agent.status).toBe("idle");
      } finally {
        await client.close();
        await daemon.close();
        rmSync(cwd, { recursive: true, force: true });
      }
    },
    600_000
  );

  test.runIf(isCommandAvailable("claude"))(
    "returns to running after background sleep completes without a second prompt",
    async () => {
      const logger = pino({ level: "silent" });
      const cwd = tmpCwd();
      const daemon = await createTestJunctionDaemon({
        agentClients: { claude: new ClaudeAgentClient({ logger }) },
        logger,
      });
      const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });

      try {
        await client.connect();
        await client.fetchAgents({
          subscribe: { subscriptionId: "claude-autonomous-wake-real" },
        });

        const agent = await client.createAgent({
          cwd,
          title: "claude-autonomous-wake-real",
          ...getFullAccessConfig("claude"),
        });

        await client.sendMessage(
          agent.id,
          [
            "Use a background task to run exactly: sleep 5",
            "Do not wait for it to finish.",
            "After launching it, reply with exactly: SPAWNED",
          ].join(" ")
        );

        const firstFinish = await client.waitForFinish(agent.id, 240_000);
        expect(firstFinish.status).toBe("idle");

        const timelineBeforeWake = await client.fetchAgentTimeline(agent.id, {
          direction: "tail",
          limit: 0,
          projection: "canonical",
        });
        const summarized = timelineBeforeWake.entries.map(summarizeTimelineEntry);
        // Required by reproduction request: log timeline at idle edge before autonomous wake.
        // eslint-disable-next-line no-console
        console.log("TIMELINE_BEFORE_AUTONOMOUS_WAKE\n" + summarized.join("\n"));
        expect(summarized.some((line) => line.includes("SPAWNED"))).toBe(true);

        // No new user prompt here: we expect autonomous transition caused by
        // background task completion notification.
        await client.waitForAgentUpsert(
          agent.id,
          (snapshot) => snapshot.status === "running",
          30_000
        );
      } finally {
        await client.close();
        await daemon.close();
        rmSync(cwd, { recursive: true, force: true });
      }
    },
    420_000
  );

  test.runIf(isCommandAvailable("claude"))(
    "accepts a new prompt after background sleep finishes and replies HELLO",
    async () => {
      const logger = pino({ level: "silent" });
      const cwd = tmpCwd();
      const daemon = await createTestJunctionDaemon({
        agentClients: { claude: new ClaudeAgentClient({ logger }) },
        logger,
      });
      const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });

      try {
        await client.connect();
        await client.fetchAgents({
          subscribe: { subscriptionId: "claude-autonomous-followup-real" },
        });

        const agent = await client.createAgent({
          cwd,
          title: "claude-autonomous-followup-real",
          ...getFullAccessConfig("claude"),
        });

        await client.sendMessage(
          agent.id,
          [
            "Use a background task to run exactly: sleep 5",
            "Do not wait for it to finish.",
            "After launching it, reply with exactly: SPAWNED",
          ].join(" ")
        );
        const firstFinish = await client.waitForFinish(agent.id, 240_000);
        expect(firstFinish.status).toBe("idle");

        await new Promise((resolve) => setTimeout(resolve, 6_000));

        await client.sendMessage(agent.id, "say exactly HELLO");
        const secondFinish = await client.waitForFinish(agent.id, 240_000);
        expect(secondFinish.status).toBe("idle");
        expect((secondFinish.lastMessage ?? "").toUpperCase()).toContain("HELLO");
      } finally {
        await client.close();
        await daemon.close();
        rmSync(cwd, { recursive: true, force: true });
      }
    },
    420_000
  );

  test.runIf(isCommandAvailable("claude"))(
    "repro: do-it-again + immediate hello can hang after autonomous wake under churn",
    async () => {
      const logger = pino({ level: "silent" });
      const cwd = tmpCwd();
      const daemon = await createTestJunctionDaemon({
        agentClients: { claude: new ClaudeAgentClient({ logger }) },
        logger,
      });
      const wsUrl = `ws://127.0.0.1:${daemon.port}/ws`;
      const client = new DaemonClient({ url: wsUrl });

      try {
        await client.connect();
        await client.fetchAgents({
          subscribe: { subscriptionId: "claude-hang-repro-real" },
        });

        const agent = await client.createAgent({
          cwd,
          title: "claude-hang-repro-real",
          ...getFullAccessConfig("claude"),
        });

        for (let cycle = 0; cycle < 20; cycle += 1) {
          const noise = runPreHelloNoise({ wsUrl, durationMs: 9_000 });

          await client.sendMessage(agent.id, BACKGROUND_TASK_SLEEP_5_PROMPT);
          const firstKickoff = await client.waitForFinish(agent.id, 180_000);
          expect(firstKickoff.status).toBe("idle");

          await client.waitForAgentUpsert(
            agent.id,
            (snapshot) => snapshot.status === "running",
            30_000
          );
          const firstCompletion = await client.waitForFinish(agent.id, 90_000);
          expect(firstCompletion.status).toBe("idle");

          await client.sendMessage(agent.id, BACKGROUND_TASK_SLEEP_5_REPEAT_PROMPT);
          const secondKickoff = await client.waitForFinish(agent.id, 180_000);
          expect(secondKickoff.status).toBe("idle");

          await client.sendMessage(agent.id, "say exactly HELLO");
          const helloReply = await client.waitForFinish(agent.id, 180_000);
          expect(helloReply.status).toBe("idle");
          expect((helloReply.lastMessage ?? "").trim().toUpperCase()).toContain("HELLO");

          const runningSnapshot = await client.waitForAgentUpsert(
            agent.id,
            (snapshot) => snapshot.status === "running",
            30_000
          );

          const timelineAtWake = await client.fetchAgentTimeline(agent.id, {
            direction: "tail",
            limit: 0,
            projection: "canonical",
          });

          // eslint-disable-next-line no-console
          console.log(
            JSON.stringify({
              cycle,
              wakeUpdatedAt: runningSnapshot.updatedAt,
              entriesAtWake: timelineAtWake.entries.length,
            })
          );

          await sleep(6_000);
          const timelineAfterWake = await client.fetchAgentTimeline(agent.id, {
            direction: "tail",
            limit: 0,
            projection: "canonical",
          });
          expect(timelineAfterWake.entries.length).toBeGreaterThanOrEqual(
            timelineAtWake.entries.length
          );

          let secondCompletion;
          try {
            secondCompletion = await client.waitForFinish(agent.id, 20_000);
          } catch {
            const atTimeoutResult = await client.fetchAgent(agent.id);
            // eslint-disable-next-line no-console
            console.log(
              JSON.stringify({
                cycle,
                phase: "second_completion_timeout",
                statusAtTimeout: atTimeoutResult?.agent.status ?? "unknown",
              })
            );
            secondCompletion = await client.waitForFinish(agent.id, 30_000);
          }
          expect(secondCompletion.status).toBe("idle");

          await noise;
        }
      } finally {
        await client.close();
        await daemon.close();
        rmSync(cwd, { recursive: true, force: true });
      }
    },
    900_000
  );

  test.runIf(isCommandAvailable("claude"))(
    "repro: second background sleep completion after HELLO should settle back to idle",
    async () => {
      const logger = pino({ level: "silent" });
      const cwd = tmpCwd();
      const daemon = await createTestJunctionDaemon({
        agentClients: { claude: new ClaudeAgentClient({ logger }) },
        logger,
      });
      const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });

      try {
        await client.connect();
        await client.fetchAgents({
          subscribe: { subscriptionId: "claude-background-repro-real" },
        });

        const agent = await client.createAgent({
          cwd,
          title: "claude-background-repro-real",
          ...getFullAccessConfig("claude"),
        });

        await client.sendMessage(agent.id, BACKGROUND_TASK_SLEEP_5_PROMPT);
        const firstKickoff = await client.waitForFinish(agent.id, 180_000);
        expect(firstKickoff.status).toBe("idle");

        await client.waitForAgentUpsert(
          agent.id,
          (snapshot) => snapshot.status === "running",
          30_000
        );
        const firstCompletion = await client.waitForFinish(agent.id, 60_000);
        expect(firstCompletion.status).toBe("idle");

        await client.sendMessage(agent.id, BACKGROUND_TASK_SLEEP_5_REPEAT_PROMPT);
        const secondKickoff = await client.waitForFinish(agent.id, 180_000);
        expect(secondKickoff.status).toBe("idle");

        await client.sendMessage(agent.id, "say exactly HELLO");
        const helloReply = await client.waitForFinish(agent.id, 180_000);
        expect(helloReply.status).toBe("idle");
        expect((helloReply.lastMessage ?? "").trim().toUpperCase()).toContain("HELLO");

        await client.waitForAgentUpsert(
          agent.id,
          (snapshot) => snapshot.status === "running",
          30_000
        );

        // This is the failure point seen in production: agent flips to running
        // on task completion and never settles back to idle.
        let secondCompletion;
        try {
          secondCompletion = await client.waitForFinish(agent.id, 20_000);
        } catch {
          const atTimeoutResult = await client.fetchAgent(agent.id);
          // eslint-disable-next-line no-console
          console.log(
            JSON.stringify({
              phase: "second_background_completion_timeout",
              statusAtTimeout: atTimeoutResult?.agent.status ?? "unknown",
            })
          );
          secondCompletion = await client.waitForFinish(agent.id, 30_000);
        }
        expect(secondCompletion.status).toBe("idle");
      } finally {
        await client.close();
        await daemon.close();
        rmSync(cwd, { recursive: true, force: true });
      }
    },
    600_000
  );

  test.runIf(isCommandAvailable("claude"))(
    "stress: immediate HELLO before task notification should not leave autonomous run stuck",
    async () => {
      const logger = pino({ level: "silent" });
      const cwd = tmpCwd();
      const daemon = await createTestJunctionDaemon({
        agentClients: { claude: new ClaudeAgentClient({ logger }) },
        logger,
      });
      const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });

      try {
        await client.connect();
        await client.fetchAgents({
          subscribe: { subscriptionId: "claude-autonomous-race-stress-real" },
        });

        const agent = await client.createAgent({
          cwd,
          title: "claude-autonomous-race-stress-real",
          ...getFullAccessConfig("claude"),
        });

        for (let cycle = 0; cycle < 20; cycle += 1) {
          const helloToken = `HELLO_CYCLE_${cycle}`;

          await client.sendMessage(
            agent.id,
            [
              "Use the Task tool (not a Bash background process).",
              "Start a background task that runs exactly: sleep 3",
              "Do not wait for the task result.",
              "Immediately reply with exactly: SPAWNED",
            ].join(" ")
          );

          const firstFinish = await client.waitForFinish(agent.id, 240_000);
          expect(firstFinish.status).toBe("idle");

          // Race path under test: immediately send the next user prompt before
          // the background-task completion notification wakes Claude again.
          await client.sendMessage(agent.id, `say exactly ${helloToken}`);
          const secondFinish = await client.waitForFinish(agent.id, 240_000);
          expect(secondFinish.status).toBe("idle");
          expect(secondFinish.lastMessage?.trim()).toBe(helloToken);

          const wakeSnapshot = await client.waitForAgentUpsert(
            agent.id,
            (snapshot) => snapshot.status === "running",
            20_000
          );

          const timelineAtWake = await client.fetchAgentTimeline(agent.id, {
            direction: "tail",
            limit: 0,
            projection: "canonical",
          });

          // eslint-disable-next-line no-console
          console.log(
            JSON.stringify({
              cycle,
              autonomousWakeUpdatedAt: wakeSnapshot.updatedAt,
              timelineEntriesAtWake: timelineAtWake.entries.length,
            })
          );

          await sleep(3_000);
          const timelineAfterWake = await client.fetchAgentTimeline(agent.id, {
            direction: "tail",
            limit: 0,
            projection: "canonical",
          });
          expect(timelineAfterWake.entries.length).toBeGreaterThanOrEqual(
            timelineAtWake.entries.length
          );

          await client.cancelAgent(agent.id);
          const afterCancel = await client.waitForFinish(agent.id, 10_000);
          expect(afterCancel.status).toBe("idle");
        }
      } finally {
        await client.close();
        await daemon.close();
        rmSync(cwd, { recursive: true, force: true });
      }
    },
    900_000
  );

  test.runIf(isCommandAvailable("claude"))(
    "repro: transcript/timeline parity after do-it-again + hello race (hang + interrupt + drop)",
    async () => {
      const logger = pino({ level: "silent" });
      const cwd = tmpCwd();
      const daemon = await createTestJunctionDaemon({
        agentClients: { claude: new ClaudeAgentClient({ logger }) },
        logger,
      });
      const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });

      try {
        await client.connect();
        await client.fetchAgents({
          subscribe: { subscriptionId: "claude-transcript-parity-race" },
        });

        const agent = await client.createAgent({
          cwd,
          title: "claude-transcript-parity-race",
          ...getFullAccessConfig("claude"),
        });

        await client.sendMessage(agent.id, BACKGROUND_TASK_SLEEP_5_PROMPT);
        const firstKickoff = await client.waitForFinish(agent.id, 180_000);
        expect(firstKickoff.status).toBe("idle");

        await client.waitForAgentUpsert(
          agent.id,
          (snapshot) => snapshot.status === "running",
          30_000
        );
        const firstAutonomousCompletion = await client.waitForFinish(agent.id, 60_000);
        expect(firstAutonomousCompletion.status).toBe("idle");

        await client.sendMessage(agent.id, BACKGROUND_TASK_SLEEP_5_REPEAT_PROMPT);
        const secondKickoff = await client.waitForFinish(agent.id, 180_000);
        expect(secondKickoff.status).toBe("idle");

        await client.waitForAgentUpsert(
          agent.id,
          (snapshot) => snapshot.status === "running",
          30_000
        );
        await sleep(500);
        await client.sendMessage(agent.id, "say exactly HELLO");

        let waitError: Error | null = null;
        try {
          await client.waitForFinish(agent.id, 20_000);
        } catch (error) {
          waitError =
            error instanceof Error ? error : new Error(String(error ?? "wait_for_finish failed"));
        }

        let afterWaitResult = await client.fetchAgent(agent.id);
        let cancelRecovered = true;
        if (afterWaitResult?.agent.status === "running") {
          await client.cancelAgent(agent.id);
          try {
            const afterCancel = await client.waitForFinish(agent.id, 15_000);
            cancelRecovered = afterCancel.status === "idle";
          } catch {
            cancelRecovered = false;
          }
          afterWaitResult = await client.fetchAgent(agent.id);
        }

        expect(waitError).toBeNull();
        expect(cancelRecovered).toBe(true);

        const afterWait = afterWaitResult?.agent ?? null;
        const sessionId =
          afterWait?.persistence?.sessionId ??
          afterWait?.runtimeInfo?.sessionId ??
          null;
        expect(typeof sessionId === "string" && sessionId.length > 0).toBe(true);
        const transcriptCwd = afterWait?.cwd ?? cwd;
        const transcriptPath = resolveClaudeTranscriptPath({
          cwd: transcriptCwd,
          sessionId: sessionId as string,
        });

        let evidence: TranscriptRaceEvidence | null = null;
        const transcriptDeadline = Date.now() + 20_000;
        while (Date.now() < transcriptDeadline) {
          const lines = readTranscriptLines(transcriptPath);
          evidence = extractTranscriptRaceEvidence(lines);
          if (evidence) {
            break;
          }
          await sleep(250);
        }
        if (!evidence) {
          const transcriptDump = summarizeTranscriptTail(readTranscriptLines(transcriptPath));
          throw new Error(
            [
              "Failed to extract transcript race evidence (hello assistant and notification-turn assistant).",
              `transcriptPath=${transcriptPath}`,
              `waitError=${waitError ? waitError.message : "null"}`,
              `afterWaitStatus=${afterWait?.status ?? "unknown"}`,
              `cancelRecovered=${cancelRecovered}`,
              "transcriptTail:",
              transcriptDump,
            ].join("\n")
          );
        }

        const helloAssistant = compactText(evidence.helloAssistantText);
        const notificationAssistant = compactText(
          evidence.notificationOutcomeAssistantText
        );
        let assistantTexts: string[] = [];
        let assistantTextCombined = "";
        const timelineDeadline = Date.now() + 20_000;
        while (Date.now() < timelineDeadline) {
          const timeline = await client.fetchAgentTimeline(agent.id, {
            direction: "tail",
            limit: 0,
            projection: "canonical",
          });
          assistantTexts = timeline.entries
            .filter(
              (
                entry
              ): entry is {
                item: { type: "assistant_message"; text: string };
              } => entry.item.type === "assistant_message"
            )
            .map((entry) => compactText(entry.item.text));
          assistantTextCombined = assistantTexts.join("");
          if (
            assistantTextCombined.includes(helloAssistant) &&
            assistantTextCombined.includes(notificationAssistant)
          ) {
            break;
          }
          await sleep(250);
        }

        expect(assistantTextCombined.includes(helloAssistant)).toBe(true);
        expect(assistantTextCombined.includes(notificationAssistant)).toBe(true);
      } finally {
        await client.close();
        await daemon.close();
        rmSync(cwd, { recursive: true, force: true });
      }
    },
    600_000
  );
});

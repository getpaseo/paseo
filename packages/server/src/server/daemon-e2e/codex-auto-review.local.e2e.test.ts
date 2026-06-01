import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { appendFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { once } from "node:events";

import pino from "pino";
import { describe, expect, test } from "vitest";

import { CodexAppServerAgentClient } from "../agent/providers/codex-app-server-agent.js";
import { createMessageCollector } from "../test-utils/message-collector.js";
import { createTestPaseoDaemon } from "../test-utils/paseo-daemon.js";
import { DaemonClient } from "../test-utils/daemon-client.js";

const QA_REPORT_PATH = "/tmp/codex-auto-review-qa.md";

function parseCodexVersion(): [number, number, number] | null {
  try {
    const output = execFileSync("codex", ["--version"], { encoding: "utf8" });
    const match = output.match(/(\d+)\.(\d+)\.(\d+)/);
    if (!match) {
      return null;
    }
    return [Number(match[1]), Number(match[2]), Number(match[3])];
  } catch {
    return null;
  }
}

function codexVersionAtLeast(version: [number, number, number] | null): boolean {
  if (!version) {
    return false;
  }
  const min = [0, 115, 0] as const;
  for (let index = 0; index < min.length; index += 1) {
    if (version[index] > min[index]) return true;
    if (version[index] < min[index]) return false;
  }
  return true;
}

function sse(events: unknown[]): string {
  return events
    .map((event) => {
      const type =
        typeof event === "object" &&
        event !== null &&
        "type" in event &&
        typeof (event as { type?: unknown }).type === "string"
          ? (event as { type: string }).type
          : "message";
      return `event: ${type}\ndata: ${JSON.stringify(event)}\n\n`;
    })
    .join("");
}

function responseCreated(id: string): Record<string, unknown> {
  return { type: "response.created", response: { id } };
}

function responseCompleted(id: string): Record<string, unknown> {
  return {
    type: "response.completed",
    response: {
      id,
      usage: {
        input_tokens: 0,
        input_tokens_details: null,
        output_tokens: 0,
        output_tokens_details: null,
        total_tokens: 0,
      },
    },
  };
}

function functionCallEvent(
  callId: string,
  name: string,
  argumentsJson: string,
): Record<string, unknown> {
  return {
    type: "response.output_item.done",
    item: {
      type: "function_call",
      call_id: callId,
      name,
      arguments: argumentsJson,
    },
  };
}

function assistantMessageEvent(id: string, text: string): Record<string, unknown> {
  return {
    type: "response.output_item.done",
    item: {
      type: "message",
      role: "assistant",
      id,
      content: [{ type: "output_text", text }],
    },
  };
}

function approvalToolCallSse(): string {
  return sse([
    responseCreated("resp-main-1"),
    functionCallEvent(
      "call-write-outside",
      "exec_command",
      JSON.stringify({
        cmd: "python3 -c \"import urllib.request; urllib.request.urlopen('https://example.com', timeout=1)\"",
        yield_time_ms: 1000,
        sandbox_permissions: "require_escalated",
        justification: "Probe auto-review approval routing.",
      }),
    ),
    responseCompleted("resp-main-1"),
  ]);
}

function guardianApprovalSse(): string {
  return sse([
    responseCreated("resp-guardian-1"),
    assistantMessageEvent(
      "msg-guardian-1",
      JSON.stringify({
        outcome: "allow",
        risk_level: "low",
        user_authorization: "high",
        rationale: "Test harness approves the isolated write.",
      }),
    ),
    responseCompleted("resp-guardian-1"),
  ]);
}

function finalAnswerSse(): string {
  return sse([
    responseCreated("resp-main-2"),
    assistantMessageEvent("msg-main-2", "done"),
    responseCompleted("resp-main-2"),
  ]);
}

async function startMockResponsesServer(sequence: string[]): Promise<{
  url: string;
  close: () => Promise<void>;
  requestBodies: unknown[];
}> {
  const requestBodies: unknown[] = [];
  let index = 0;
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => {
      const rawBody = Buffer.concat(chunks).toString("utf8");
      requestBodies.push(JSON.parse(rawBody));
      if (req.method !== "POST" || req.url !== "/v1/responses") {
        res.statusCode = 404;
        res.end("not found");
        return;
      }
      const body = sequence[index] ?? finalAnswerSse();
      index += 1;
      res.statusCode = 200;
      res.setHeader("content-type", "text/event-stream");
      res.setHeader("cache-control", "no-cache");
      res.end(body);
    });
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected TCP address for mock responses server");
  }
  return {
    url: `http://127.0.0.1:${address.port}`,
    requestBodies,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      }),
  };
}

function writeMockCodexConfig(codexHome: string, serverUrl: string): void {
  writeFileSync(
    path.join(codexHome, "config.toml"),
    `
model = "mock-model"
model_provider = "mock_provider"
approval_policy = "never"
sandbox_mode = "read-only"

[features]
guardian_approval = true

[model_providers.mock_provider]
name = "Mock provider"
base_url = "${serverUrl}/v1"
wire_api = "responses"
request_max_retries = 0
stream_max_retries = 0
supports_websockets = false
`,
  );
}

function createTraceLogger() {
  const records: Array<Record<string, unknown>> = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      try {
        records.push(JSON.parse(chunk.toString()) as Record<string, unknown>);
      } catch {
        // Ignore non-JSON logger output.
      }
      callback();
    },
  });
  return {
    logger: pino({ level: "trace" }, stream),
    records,
  };
}

function rawCodexEvents(records: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return records
    .filter((record) => record.msg === "provider.codex.raw_event")
    .map((record) => ({
      method: record.method,
      params: record.params,
      rawEvent: record.rawEvent,
    }));
}

function hasClientPermissionRequest(messages: unknown[]): boolean {
  return messages.some(
    (message) =>
      typeof message === "object" &&
      message !== null &&
      "type" in message &&
      (message as { type?: unknown }).type === "agent_permission_request",
  );
}

async function appendQaSection(title: string, payload: unknown): Promise<void> {
  await appendFile(
    QA_REPORT_PATH,
    `\n## ${title}\n\n\`\`\`json\n${JSON.stringify(payload, null, 2)}\n\`\`\`\n`,
  );
}

async function runScenario(modeId: "auto" | "auto-review") {
  const cwd = mkdtempSync(path.join(os.tmpdir(), `codex-auto-review-${modeId}-cwd-`));
  const codexHome = mkdtempSync(path.join(os.tmpdir(), `codex-auto-review-${modeId}-home-`));
  const mockServer = await startMockResponsesServer(
    modeId === "auto-review"
      ? [approvalToolCallSse(), guardianApprovalSse(), finalAnswerSse()]
      : [approvalToolCallSse(), finalAnswerSse()],
  );
  const { logger, records } = createTraceLogger();
  const daemon = await createTestPaseoDaemon({
    agentClients: {
      codex: new CodexAppServerAgentClient(logger, {
        env: {
          CODEX_HOME: codexHome,
        },
      }),
    },
    logger,
  });
  const client = new DaemonClient({
    url: `ws://127.0.0.1:${daemon.port}/ws`,
    appVersion: "0.1.75",
  });
  const collector = createMessageCollector(client);

  try {
    writeMockCodexConfig(codexHome, mockServer.url);
    await client.connect();
    await client.fetchAgents({ subscribe: { subscriptionId: `codex-auto-review-${modeId}` } });

    const agent = await client.createAgent({
      provider: "codex",
      cwd,
      title: `codex-auto-review-${modeId}`,
      modeId,
      model: "mock-model",
      thinkingOptionId: "medium",
    });

    collector.clear();
    await client.sendAgentMessage(agent.id, "Run the scripted command.");

    if (modeId === "auto") {
      const permissionState = await client.waitForFinish(agent.id, 30_000);
      expect(permissionState.status).toBe("permission");
      const permission = permissionState.final?.pendingPermissions?.[0];
      expect(permission?.kind).toBe("tool");
      await client.respondToPermission(agent.id, permission!.id, { behavior: "deny" });
    }

    const finish = await client.waitForFinish(agent.id, 60_000);
    expect(finish.status).toBe("idle");

    return {
      modeId,
      websocketMessages: [...collector.messages],
      rawCodexEvents: rawCodexEvents(records),
      mockResponsesRequests: mockServer.requestBodies,
    };
  } finally {
    collector.unsubscribe();
    await client.close();
    await daemon.close();
    await mockServer.close();
    rmSync(cwd, { recursive: true, force: true });
    rmSync(codexHome, { recursive: true, force: true });
  }
}

const codexVersion = parseCodexVersion();
const canRun = codexVersionAtLeast(codexVersion);

describe.skipIf(!canRun)("daemon E2E (real codex) - Auto-review mode", () => {
  test("Auto-review routes on-request approvals through the Codex auto-reviewer subagent", async () => {
    await writeFile(
      QA_REPORT_PATH,
      `# Codex Auto-review QA\n\nE2E started with codex version ${JSON.stringify(codexVersion)}.\n`,
    );

    const result = await runScenario("auto-review");
    const methods = result.rawCodexEvents.map((event) => event.method);

    expect(methods).toContain("item/autoApprovalReview/started");
    expect(methods).toContain("item/autoApprovalReview/completed");
    expect(methods).not.toContain("item/commandExecution/requestApproval");
    expect(hasClientPermissionRequest(result.websocketMessages)).toBe(false);

    await appendQaSection("E2E Auto-review Wire Payloads", {
      rawCodexEvents: result.rawCodexEvents.filter(
        (event) =>
          event.method === "item/autoApprovalReview/started" ||
          event.method === "item/autoApprovalReview/completed",
      ),
      requestApprovalEvents: result.rawCodexEvents.filter(
        (event) => event.method === "item/commandExecution/requestApproval",
      ),
    });
  }, 90_000);

  test("Default Permissions surfaces the same approval as a client permission request", async () => {
    const result = await runScenario("auto");
    const methods = result.rawCodexEvents.map((event) => event.method);

    expect(methods).toContain("item/commandExecution/requestApproval");
    expect(methods).not.toContain("item/autoApprovalReview/started");
    expect(methods).not.toContain("item/autoApprovalReview/completed");
    expect(hasClientPermissionRequest(result.websocketMessages)).toBe(true);

    await appendQaSection("E2E Default Permissions Wire Payloads", {
      rawCodexEvents: result.rawCodexEvents.filter(
        (event) => event.method === "item/commandExecution/requestApproval",
      ),
      autoApprovalReviewEvents: result.rawCodexEvents.filter(
        (event) =>
          event.method === "item/autoApprovalReview/started" ||
          event.method === "item/autoApprovalReview/completed",
      ),
    });
  }, 90_000);
});

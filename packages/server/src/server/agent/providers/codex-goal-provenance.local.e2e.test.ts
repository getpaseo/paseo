import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { expect, test } from "vitest";
import { createTestLogger } from "../../../test-utils/test-logger.js";
import { CodexAppServerAgentClient } from "./codex-app-server-agent.js";
import type { AgentStreamEvent } from "../agent-sdk-types.js";

// Native Codex owns goals; the fixture supplies inference responses only.
test("records all four /goal commands as user edits in the next model request", async () => {
  const root = mkdtempSync(path.resolve(".dev-goal-provenance-"));
  const requests: string[] = [];
  function handleRequest(req: IncomingMessage, res: ServerResponse): void {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      if (req.method !== "POST" || req.url !== "/v1/responses") {
        res.writeHead(404).end();
        return;
      }
      requests.push(Buffer.concat(chunks).toString("utf8"));
      res.setHeader("content-type", "text/event-stream");
      const id = `resp-${requests.length}`;
      const events = [
        { type: "response.created", response: { id } },
        {
          type: "response.output_item.done",
          item: {
            type: "message",
            role: "assistant",
            id: `msg-${requests.length}`,
            content: [{ type: "output_text", text: "LOCAL_FIXTURE_RESPONSE" }],
          },
        },
        {
          type: "response.completed",
          response: {
            id,
            usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
          },
        },
      ];
      res.end(events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""));
    });
  }
  const server = createServer(handleRequest);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing fixture address");
  writeFileSync(
    path.join(root, "config.toml"),
    `
model = "gpt-6.1-sol"
model_reasoning_effort = "low"
model_provider = "fixture"
approval_policy = "never"
sandbox_mode = "read-only"
[features]
enable_request_compression = false
[model_providers.fixture]
name = "Local response fixture"
base_url = "http://127.0.0.1:${address.port}/v1"
wire_api = "responses"
requires_openai_auth = false
supports_websockets = false
request_max_retries = 0
stream_max_retries = 0
`,
  );
  const client = new CodexAppServerAgentClient(createTestLogger(), { env: { CODEX_HOME: root } });
  const session = await client.createSession({
    provider: "codex",
    cwd: root,
    model: "gpt-6.1-sol",
    thinkingOptionId: "low",
  });
  let active = false;
  const unsubscribe = session.subscribe((event) => {
    if (event.type === "turn_started") active = true;
    if (["turn_completed", "turn_canceled", "turn_failed"].includes(event.type)) active = false;
  });
  try {
    expect((await session.listCommands?.())?.some((command) => command.name === "goal")).toBe(true);
    for (const command of [
      "/goal AUDIT_GOAL: summarize local evidence",
      "/goal pause",
      "/goal resume",
      "/goal clear",
    ]) {
      const handler = session.tryHandleOutOfBand?.(command);
      expect(handler).toBeTruthy();
      const events: AgentStreamEvent[] = [];
      await handler!.run({ emit: (event) => events.push(event) });
      expect(events).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            item: expect.objectContaining({
              text: expect.stringContaining("Failed to update goal"),
            }),
          }),
        ]),
      );
    }
    await expect.poll(() => active, { timeout: 30_000 }).toBe(false);
    expect((await session.run("PROBE_AFTER_GOAL_CLEAR")).finalText).toBe("LOCAL_FIXTURE_RESPONSE");
    const body = JSON.parse(requests.at(-1)!);
    const goalContext = body.input
      .filter((item: { role: string }) => item.role === "user")
      .flatMap((item: { content: Array<{ text?: string }> }) =>
        item.content.map((part) => part.text ?? ""),
      )
      .filter((text: string) => text.includes('<codex_internal_context source="user_goal">'))
      .join("\n");
    expect(goalContext).toContain('User set the goal: "AUDIT_GOAL: summarize local evidence"');
    expect(goalContext).toContain('User set goal status: "paused".');
    expect(goalContext).toContain('User set goal status: "active".');
    expect(goalContext).toContain("User cleared the goal.");
  } finally {
    unsubscribe();
    await session.close();
    server.closeAllConnections();
    server.close();
    await once(server, "close");
    rmSync(root, { recursive: true, force: true });
  }
}, 60_000);

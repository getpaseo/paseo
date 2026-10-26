import { createServer } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import pino from "pino";
import { expect, test } from "vitest";
import { collectSessionTurnEvents } from "../test-utils/session-stream-adapter.js";
import { ClaudeAgentClient } from "./agent.js";

// Exercise the real Claude Code process against a local Messages API fixture.
// The input counter's location is the only difference between the two backends.
test.each([
  { placement: "start", cacheTokens: 0 },
  { placement: "delta", cacheTokens: 0 },
  { placement: "start", cacheTokens: 1_000 },
  { placement: "delta", cacheTokens: 1_000 },
  { placement: "start", cacheTokens: 0, model: "glm-5.2[1m]" },
  { placement: "start", cacheTokens: 0, model: "sonnet", resolvedModel: "glm-5.2[1m]" },
])(
  "counts $placement input and $cacheTokens cached tokens through Claude Code ($model)",
  async ({ placement, cacheTokens, model = "claude-sonnet-4-6", resolvedModel = model }) => {
    const cwd = await mkdtemp(path.resolve(".claude-context-usage-"));
    const configDir = path.join(cwd, "config");
    await mkdir(configDir);
    await writeFile(
      path.join(configDir, "settings.json"),
      JSON.stringify({ env: { ANTHROPIC_DEFAULT_SONNET_MODEL: resolvedModel } }),
    );
    let requestCount = 0;
    const server = createServer(async (request, response) => {
      for await (const chunk of request) {
        void chunk;
      }
      if (!request.url?.startsWith("/v1/messages")) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end("{}");
        return;
      }
      if (request.url.includes("count_tokens")) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ input_tokens: 20_236 }));
        return;
      }
      const inputTokens = 20_236 + requestCount++;
      response.writeHead(200, { "content-type": "text/event-stream" });
      const emit = (data: { type: string; [key: string]: unknown }) => {
        response.write(`event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`);
      };
      emit({
        type: "message_start",
        message: {
          id: `msg_context_usage_${requestCount}`,
          type: "message",
          role: "assistant",
          model: resolvedModel,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: {
            input_tokens: placement === "start" ? inputTokens : 0,
            output_tokens: 0,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: cacheTokens,
          },
        },
      });
      emit({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
      emit({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hello" } });
      emit({ type: "content_block_stop", index: 0 });
      emit({
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: {
          output_tokens: 64,
          ...(placement === "delta" ? { input_tokens: inputTokens } : {}),
        },
      });
      emit({ type: "message_stop" });
      response.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Fixture has no TCP address");
    const client = new ClaudeAgentClient({
      logger: pino({ level: "silent" }),
      runtimeSettings: {
        env: {
          ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}`,
          ANTHROPIC_AUTH_TOKEN: "fixture-token",
          ANTHROPIC_API_KEY: "",
          CLAUDE_CONFIG_DIR: configDir,
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
        },
      },
    });
    const session = await client.createSession({ provider: "claude", cwd, model }, undefined, {
      persistSession: false,
    });
    try {
      for (let turn = 0; turn < 2; turn++) {
        const events = await collectSessionTurnEvents(session, "say hello", {
          signal: AbortSignal.timeout(20_000),
        });
        const expectedTokens = 20_236 + turn + cacheTokens + 64;
        expect(events).toContainEqual(
          expect.objectContaining({
            type: "turn_completed",
            usage: expect.objectContaining({
              inputTokens: 20_236 + turn,
              outputTokens: 64,
              cachedInputTokens: cacheTokens,
              contextWindowUsedTokens: expectedTokens,
            }),
          }),
        );
        expect(events).toContainEqual(
          expect.objectContaining({
            type: "usage_updated",
            usage: expect.objectContaining({
              contextWindowUsedTokens: expectedTokens,
              contextWindowMaxTokens: resolvedModel.endsWith("[1m]") ? 1_000_000 : 200_000,
            }),
          }),
        );
      }
      expect(requestCount).toBe(2);
    } finally {
      try {
        await session.close();
      } finally {
        try {
          server.closeAllConnections();
          await new Promise<void>((resolve) => server.close(() => resolve()));
        } finally {
          await rm(cwd, { recursive: true, force: true });
        }
      }
    }
  },
  60_000,
);

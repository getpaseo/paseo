import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import type { TestContext } from "vitest";
import { z } from "zod";

declare module "vitest" {
  interface TaskMeta {
    beforeUserResponse?: unknown;
    pendingApproval?: unknown;
    afterUserResponse?: unknown;
    autoReviewTurn?: unknown;
    modelFixture?: unknown;
  }
}

interface FixtureOptions {
  context: TestContext;
  root: string;
  modeId: "auto" | "auto-review";
}

const responseRequest = z.object({
  model: z.string(),
  input: z.array(z.unknown()),
  text: z
    .object({
      format: z
        .object({ schema: z.object({ properties: z.record(z.string(), z.unknown()) }).optional() })
        .optional(),
    })
    .nullish(),
});

function responseStream(item: Record<string, unknown>, id: string): string {
  const events = [
    { type: "response.created", response: { id } },
    { type: "response.output_item.done", item },
    {
      type: "response.completed",
      response: { id, usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } },
    },
  ];
  return events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
}

function assistantMessage(text: string): Record<string, unknown> {
  return { type: "message", role: "assistant", content: [{ type: "output_text", text }] };
}

function writeMarker(marker: string): Record<string, unknown> {
  return {
    type: "function_call",
    call_id: `write-${marker}`,
    name: "exec_command",
    arguments: JSON.stringify({
      cmd: `node write-marker.cjs ../${marker}.txt`,
      sandbox_permissions: "require_escalated",
      justification: "Write the disposable approval-test marker outside the workspace.",
      yield_time_ms: 1000,
    }),
  };
}

export async function createCodexApprovalFixture({ context, root, modeId }: FixtureOptions) {
  const sequence = [writeMarker("user-approved"), assistantMessage("DONE")];
  if (modeId === "auto-review") {
    sequence.unshift(writeMarker("auto-approved"), assistantMessage("DONE"));
  }
  const requests: unknown[] = [];
  let responseId = 0;
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      try {
        assert.equal(request.method, "POST");
        assert.equal(request.url, "/v1/responses");
        const body = responseRequest.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        requests.push(body);
        const isReview = body.text?.format?.schema?.properties.outcome !== undefined;
        const item = isReview
          ? assistantMessage(JSON.stringify({ outcome: "allow" }))
          : sequence.shift();
        assert(item, "Unexpected extra model request: scripted responses exhausted");
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end(responseStream(item, `fixture-${++responseId}`));
      } catch (error) {
        requests.push({ error: String(error) });
        response.writeHead(500);
        response.end(String(error));
      }
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  context.onTestFinished(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
    context.task.meta.modelFixture = { modelOutput: "scripted, no live inference", requests };
  });
  const address = server.address();
  assert(address && typeof address !== "string");
  const codexHome = path.join(root, "codex-home");
  await mkdir(codexHome);
  await writeFile(
    path.join(codexHome, "config.toml"),
    `
model = "mock-model"
model_provider = "approval_fixture"

[features]
unified_exec = true

[model_providers.approval_fixture]
name = "Scripted approval test fixture (no live model)"
base_url = "http://127.0.0.1:${address.port}/v1"
wire_api = "responses"
requires_openai_auth = false
supports_websockets = false
request_max_retries = 0
stream_max_retries = 0
`,
  );
  return { codexHome };
}

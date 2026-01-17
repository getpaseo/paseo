import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, existsSync, rmSync, mkdirSync, readFileSync, readdirSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import {
  createDaemonTestContext,
  type DaemonTestContext,
} from "../test-utils/index.js";
import type { AgentTimelineItem } from "../agent/agent-sdk-types.js";
import type { AgentSnapshotPayload, SessionOutboundMessage } from "../messages.js";

function tmpCwd(): string {
  return mkdtempSync(path.join(tmpdir(), "daemon-e2e-"));
}

// Use gpt-5.1-codex-mini with low reasoning effort for faster test execution
const CODEX_TEST_MODEL = "gpt-5.1-codex-mini";
const CODEX_TEST_REASONING_EFFORT = "low";

describe("daemon E2E", () => {
  let ctx: DaemonTestContext;

  beforeEach(async () => {
    ctx = await createDaemonTestContext();
  });

  afterEach(async () => {
    await ctx.cleanup();
  }, 60000);

  describe("file download tokens", () => {
    test(
      "issues token over WS and downloads via HTTP",
      async () => {
        const cwd = tmpCwd();
        const filePath = path.join(cwd, "download.txt");
        const fileContents = "download test payload";
        writeFileSync(filePath, fileContents, "utf-8");

        const agent = await ctx.client.createAgent({
          provider: "codex", model: CODEX_TEST_MODEL, reasoningEffort: CODEX_TEST_REASONING_EFFORT,
          cwd,
          title: "Download Token Test Agent",
        });

        expect(agent.id).toBeTruthy();

        const tokenResponse = await ctx.client.requestDownloadToken(
          agent.id,
          "download.txt"
        );

        expect(tokenResponse.error).toBeNull();
        expect(tokenResponse.token).toBeTruthy();
        expect(tokenResponse.fileName).toBe("download.txt");

        const authHeader = ctx.daemon.agentMcpAuthHeader;
        expect(authHeader).toBeTruthy();

        const response = await fetch(
          `http://127.0.0.1:${ctx.daemon.port}/api/files/download?token=${tokenResponse.token}`,
          { headers: { Authorization: authHeader! } }
        );

        expect(response.status).toBe(200);
        expect(response.headers.get("content-type")).toBe(
          tokenResponse.mimeType
        );
        const disposition = response.headers.get("content-disposition") ?? "";
        expect(disposition).toContain("download.txt");

        const body = await response.text();
        expect(body).toBe(fileContents);

        rmSync(cwd, { recursive: true, force: true });
      },
      60000
    );

    test(
      "rejects invalid token",
      async () => {
        const authHeader = ctx.daemon.agentMcpAuthHeader;
        expect(authHeader).toBeTruthy();

        const response = await fetch(
          `http://127.0.0.1:${ctx.daemon.port}/api/files/download?token=invalid-token`,
          { headers: { Authorization: authHeader! } }
        );

        expect(response.status).toBe(403);
      },
      30000
    );

    test(
      "rejects expired token",
      async () => {
        await ctx.cleanup();
        ctx = await createDaemonTestContext({ downloadTokenTtlMs: 50 });

        const cwd = tmpCwd();
        const filePath = path.join(cwd, "expired.txt");
        writeFileSync(filePath, "expired", "utf-8");

        const agent = await ctx.client.createAgent({
          provider: "codex", model: CODEX_TEST_MODEL, reasoningEffort: CODEX_TEST_REASONING_EFFORT,
          cwd,
          title: "Expired Token Test Agent",
        });

        const tokenResponse = await ctx.client.requestDownloadToken(
          agent.id,
          "expired.txt"
        );

        expect(tokenResponse.error).toBeNull();
        expect(tokenResponse.token).toBeTruthy();

        await new Promise((resolve) => setTimeout(resolve, 150));

        const authHeader = ctx.daemon.agentMcpAuthHeader;
        expect(authHeader).toBeTruthy();

        const response = await fetch(
          `http://127.0.0.1:${ctx.daemon.port}/api/files/download?token=${tokenResponse.token}`,
          { headers: { Authorization: authHeader! } }
        );

        expect(response.status).toBe(403);

        rmSync(cwd, { recursive: true, force: true });
      },
      60000
    );

    test(
      "rejects paths outside the agent cwd",
      async () => {
        const cwd = tmpCwd();
        const agent = await ctx.client.createAgent({
          provider: "codex", model: CODEX_TEST_MODEL, reasoningEffort: CODEX_TEST_REASONING_EFFORT,
          cwd,
          title: "Outside Path Token Test Agent",
        });

        const tokenResponse = await ctx.client.requestDownloadToken(
          agent.id,
          "../outside.txt"
        );

        expect(tokenResponse.token).toBeNull();
        expect(tokenResponse.error).toBeTruthy();

        rmSync(cwd, { recursive: true, force: true });
      },
      60000
    );
  });


});

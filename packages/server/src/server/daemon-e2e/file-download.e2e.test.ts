import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { createDaemonTestContext, type DaemonTestContext } from "../test-utils/index.js";

function tmpCwd(): string {
  return mkdtempSync(path.join(tmpdir(), "daemon-e2e-"));
}

// Use gpt-5.4-mini with low thinking preset for faster test execution
const CODEX_TEST_MODEL = "gpt-5.4-mini";
const CODEX_TEST_THINKING_OPTION_ID = "low";

describe("daemon E2E", () => {
  let ctx: DaemonTestContext;

  beforeEach(async () => {
    ctx = await createDaemonTestContext();
  });

  afterEach(async () => {
    await ctx.cleanup();
  }, 60000);

  describe("file download tokens", () => {
    test("issues token over WS and downloads via HTTP", async () => {
      const cwd = tmpCwd();
      const filePath = path.join(cwd, "download.txt");
      const fileContents = "download test payload";
      writeFileSync(filePath, fileContents, "utf-8");

      const agent = await ctx.client.createAgent({
        provider: "codex",
        model: CODEX_TEST_MODEL,
        thinkingOptionId: CODEX_TEST_THINKING_OPTION_ID,
        cwd,
        title: "Download Token Test Agent",
      });

      expect(agent.id).toBeTruthy();

      const tokenResponse = await ctx.client.requestDownloadToken(cwd, "download.txt");

      expect(tokenResponse.error).toBeNull();
      expect(tokenResponse.token).toBeTruthy();
      expect(tokenResponse.fileName).toBe("download.txt");

      const response = await fetch(
        `http://127.0.0.1:${ctx.daemon.port}/api/files/download?token=${tokenResponse.token}`,
      );

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe(tokenResponse.mimeType);
      const disposition = response.headers.get("content-disposition") ?? "";
      expect(disposition).toContain("download.txt");

      const body = await response.text();
      expect(body).toBe(fileContents);

      rmSync(cwd, { recursive: true, force: true });
    }, 60000);

    test("downloads files with non-ASCII names", async () => {
      const cwd = tmpCwd();
      const fileName = "中文报告 (最终版).txt";
      const filePath = path.join(cwd, fileName);
      const fileContents = "unicode download payload";
      writeFileSync(filePath, fileContents, "utf-8");

      const agent = await ctx.client.createAgent({
        provider: "codex",
        model: CODEX_TEST_MODEL,
        thinkingOptionId: CODEX_TEST_THINKING_OPTION_ID,
        cwd,
        title: "Unicode Download Token Test Agent",
      });

      expect(agent.id).toBeTruthy();

      const tokenResponse = await ctx.client.requestDownloadToken(cwd, fileName);

      expect(tokenResponse.error).toBeNull();
      expect(tokenResponse.token).toBeTruthy();
      expect(tokenResponse.fileName).toBe(fileName);

      const response = await fetch(
        `http://127.0.0.1:${ctx.daemon.port}/api/files/download?token=${tokenResponse.token}`,
      );

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe(tokenResponse.mimeType);

      const disposition = response.headers.get("content-disposition") ?? "";
      // Independent RFC 6266/5987 contract — do not assert via content-disposition()
      // itself (that would only prove the server and the test share a library).
      expect(disposition).toMatch(/^attachment;/i);
      expect(disposition).toMatch(/filename=/i);
      expect(disposition).toMatch(/filename\*=UTF-8''/i);
      // Header bytes must be ASCII-safe for Node setHeader (no raw CJK/emoji).
      expect(disposition).not.toContain("中");
      for (let i = 0; i < disposition.length; i++) {
        expect(disposition.charCodeAt(i)).toBeLessThan(128);
      }
      // filename* must decode back to the original Unicode basename.
      const encodedName = disposition.match(/filename\*=UTF-8''([^;\s]+)/i)?.[1];
      expect(encodedName).toBeTruthy();
      expect(decodeURIComponent(encodedName!)).toBe(fileName);

      const body = await response.text();
      expect(body).toBe(fileContents);

      rmSync(cwd, { recursive: true, force: true });
    }, 60000);

    test("rejects invalid token", async () => {
      const response = await fetch(
        `http://127.0.0.1:${ctx.daemon.port}/api/files/download?token=invalid-token`,
      );

      expect(response.status).toBe(403);
    }, 30000);

    test("rejects expired token", async () => {
      await ctx.cleanup();
      ctx = await createDaemonTestContext({ downloadTokenTtlMs: 50 });

      const cwd = tmpCwd();
      const filePath = path.join(cwd, "expired.txt");
      writeFileSync(filePath, "expired", "utf-8");

      await ctx.client.createAgent({
        provider: "codex",
        model: CODEX_TEST_MODEL,
        thinkingOptionId: CODEX_TEST_THINKING_OPTION_ID,
        cwd,
        title: "Expired Token Test Agent",
      });

      const tokenResponse = await ctx.client.requestDownloadToken(cwd, "expired.txt");

      expect(tokenResponse.error).toBeNull();
      expect(tokenResponse.token).toBeTruthy();

      await new Promise((resolve) => setTimeout(resolve, 150));

      const response = await fetch(
        `http://127.0.0.1:${ctx.daemon.port}/api/files/download?token=${tokenResponse.token}`,
      );

      expect(response.status).toBe(403);

      rmSync(cwd, { recursive: true, force: true });
    }, 60000);

    test("rejects paths outside the workspace cwd", async () => {
      const cwd = tmpCwd();
      await ctx.client.createAgent({
        provider: "codex",
        model: CODEX_TEST_MODEL,
        thinkingOptionId: CODEX_TEST_THINKING_OPTION_ID,
        cwd,
        title: "Outside Path Token Test Agent",
      });

      const tokenResponse = await ctx.client.requestDownloadToken(cwd, "../outside.txt");

      expect(tokenResponse.token).toBeNull();
      expect(tokenResponse.error).toBeTruthy();

      rmSync(cwd, { recursive: true, force: true });
    }, 60000);
  });
});

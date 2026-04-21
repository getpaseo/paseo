#!/usr/bin/env npx tsx

import assert from "node:assert";
import { execFile } from "node:child_process";
import http from "node:http";
import { join } from "node:path";
import { promisify } from "node:util";

const CLI_SOURCE_ENTRY = join(import.meta.dirname, "..", "src", "index.ts");
const execFileAsync = promisify(execFile);

console.log("=== WeChat Commands ===\n");

async function runCli(args: string[]): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
}> {
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      ["./node_modules/.bin/tsx", CLI_SOURCE_ENTRY, ...args],
      {
        cwd: process.cwd(),
        env: process.env,
      },
    );
    return { exitCode: 0, stdout, stderr };
  } catch (error) {
    const failure = error as {
      code?: number;
      stdout?: string;
      stderr?: string;
    };
    return {
      exitCode: typeof failure.code === "number" ? failure.code : 1,
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? "",
    };
  }
}

const requests: Array<{ path: string; body: Record<string, unknown> | null }> = [];

const server = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (chunk) => {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  });
  req.on("end", () => {
    const raw = Buffer.concat(chunks).toString("utf8");
    const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
    requests.push({ path: req.url ?? "", body });

    if (req.method === "POST" && req.url === "/api/wechat/login/start") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          sessionKey: "wechat-session-1",
          qrcodeUrl: "https://example.com/wechat-qr",
        }),
      );
      return;
    }

    if (req.method === "POST" && req.url === "/api/wechat/login/wait") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          connected: true,
          accountId: "bot123-im-bot",
          userId: "owner@im.wechat",
          message: "ok",
        }),
      );
      return;
    }

    if (req.method === "GET" && req.url === "/api/wechat/accounts") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          accounts: [
            {
              id: "bot123-im-bot",
              rawAccountId: "bot123@im.bot",
              userId: "owner@im.wechat",
              baseUrl: "https://ilinkai.weixin.qq.com",
              enabled: true,
              running: true,
              createdAt: "2026-04-20T12:00:00.000Z",
              updatedAt: "2026-04-20T12:01:00.000Z",
              lastInboundAt: "2026-04-20T12:02:00.000Z",
              lastOutboundAt: "2026-04-20T12:03:00.000Z",
              lastError: null,
            },
          ],
        }),
      );
      return;
    }

    if (req.method === "GET" && req.url === "/api/wechat/sessions") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          sessions: [
            {
              accountId: "bot123-im-bot",
              accountUserId: "owner@im.wechat",
              peerId: "user001@im.wechat",
              agentId: "agent-1",
              agentTitle: "WeChat user001@im.wechat",
              agentStatus: "idle",
              contextTokenPresent: true,
              createdAt: "2026-04-20T12:00:00.000Z",
              updatedAt: "2026-04-20T12:03:00.000Z",
            },
          ],
        }),
      );
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  });
});

await new Promise<void>((resolve) => {
  server.listen(0, "127.0.0.1", () => resolve());
});

const address = server.address();
if (!address || typeof address === "string") {
  throw new Error("Failed to resolve test server port");
}

try {
  // Test 1: help should expose the login command
  {
    console.log("Test 1: wechat --help shows login subcommand");
    const result = await runCli(["wechat", "--help"]);
    assert.strictEqual(result.exitCode, 0, "wechat --help should exit 0");
    assert(result.stdout.includes("login"), "help should mention login subcommand");
    console.log("✓ wechat --help shows login subcommand\n");
  }

  // Test 2: login renders qr and waits for success
  {
    console.log("Test 2: wechat login prints QR and completes login flow");
    const result = await runCli([
      "wechat",
      "login",
      "--host",
      `127.0.0.1:${address.port}`,
      "--timeout",
      "2",
    ]);
    assert.strictEqual(result.exitCode, 0, "wechat login should succeed");
    assert(result.stdout.includes("Scan this WeChat QR code:"), "output should include QR header");
    assert(result.stdout.includes("https://example.com/wechat-qr"), "output should include QR URL");
    assert(result.stdout.includes("WeChat login connected."), "output should confirm success");
    assert(result.stdout.includes("Account: bot123-im-bot"), "output should include account ID");
    assert(result.stdout.includes("User: owner@im.wechat"), "output should include user ID");
    assert.strictEqual(requests.length, 2, "command should call start and wait endpoints");
    assert.strictEqual(requests[0]?.path, "/api/wechat/login/start");
    assert.strictEqual(requests[1]?.path, "/api/wechat/login/wait");
    assert.strictEqual(requests[1]?.body?.sessionKey, "wechat-session-1");
    assert.strictEqual(requests[1]?.body?.timeoutMs, 2000);
    console.log("✓ wechat login prints QR and completes login flow\n");
  }

  // Test 3: top-level alias should complete the same flow
  {
    console.log("Test 3: wechat-login alias completes login flow");
    const result = await runCli([
      "wechat-login",
      "--host",
      `127.0.0.1:${address.port}`,
      "--timeout",
      "2",
      "--json",
    ]);
    assert.strictEqual(result.exitCode, 0, "wechat-login should succeed");
    const payload = JSON.parse(result.stdout);
    assert.strictEqual(payload.connected, true, "json output should report success");
    assert.strictEqual(payload.accountId, "bot123-im-bot");
    assert.strictEqual(payload.userId, "owner@im.wechat");
    assert.strictEqual(requests[2]?.path, "/api/wechat/login/start");
    assert.strictEqual(requests[3]?.path, "/api/wechat/login/wait");
    assert.strictEqual(requests[3]?.body?.timeoutMs, 2000);
    console.log("✓ wechat-login alias completes login flow\n");
  }
  // Test 4: status should list connected accounts
  {
    console.log("Test 4: wechat status lists connected accounts");
    const result = await runCli([
      "wechat",
      "status",
      "--host",
      `127.0.0.1:${address.port}`,
      "--json",
    ]);
    assert.strictEqual(result.exitCode, 0, "wechat status should succeed");
    const payload = JSON.parse(result.stdout);
    assert(Array.isArray(payload.accounts), "json output should contain accounts array");
    assert.strictEqual(payload.accounts.length, 1, "status should return one account");
    assert.strictEqual(payload.accounts[0]?.id, "bot123-im-bot");
    assert.strictEqual(payload.accounts[0]?.running, true);
    assert.strictEqual(payload.accounts[0]?.enabled, true);
    assert.strictEqual(requests[4]?.path, "/api/wechat/accounts");
    console.log("✓ wechat status lists connected accounts\n");
  }

  // Test 5: sessions should list peer-to-agent mappings
  {
    console.log("Test 5: wechat sessions lists peer mappings");
    const result = await runCli([
      "wechat",
      "sessions",
      "--host",
      `127.0.0.1:${address.port}`,
      "--json",
    ]);
    assert.strictEqual(result.exitCode, 0, "wechat sessions should succeed");
    const payload = JSON.parse(result.stdout);
    assert(Array.isArray(payload.sessions), "json output should contain sessions array");
    assert.strictEqual(payload.sessions.length, 1, "sessions should return one mapping");
    assert.strictEqual(payload.sessions[0]?.agentId, "agent-1");
    assert.strictEqual(payload.sessions[0]?.peerId, "user001@im.wechat");
    assert.strictEqual(payload.sessions[0]?.agentStatus, "idle");
    assert.strictEqual(requests[5]?.path, "/api/wechat/sessions");
    console.log("✓ wechat sessions lists peer mappings\n");
  }
} finally {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

console.log("=== All WeChat tests passed ===");

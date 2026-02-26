import net from "node:net";
import os from "node:os";
import path from "node:path";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { describe, expect, test } from "vitest";
import { experimental_createMCPClient } from "ai";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import pino from "pino";

import { createJunctionDaemon, type JunctionDaemonConfig } from "../bootstrap.js";
import { createTestAgentClients } from "../test-utils/fake-agent-client.js";

type StructuredContent = { [key: string]: unknown };

type McpToolResult = {
  structuredContent?: StructuredContent;
  content?: Array<{ structuredContent?: StructuredContent } | StructuredContent>;
};

type McpClient = {
  callTool: (input: { name: string; args?: StructuredContent }) => Promise<unknown>;
  close: () => Promise<void>;
};

async function withTimeout<T>(
  options: { promise: Promise<T>; timeoutMs: number; label: string }
): Promise<T> {
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      reject(new Error(`Timed out after ${options.timeoutMs}ms (${options.label})`));
    }, options.timeoutMs);
  });
  try {
    return await Promise.race([options.promise, timeout]);
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
}

async function waitForPathExists(
  options: { targetPath: string; timeoutMs: number }
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < options.timeoutMs) {
    if (existsSync(options.targetPath)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(
    `Timed out after ${options.timeoutMs}ms waiting for path: ${options.targetPath}`
  );
}

async function getAvailablePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Failed to acquire port")));
        return;
      }
      server.close(() => resolve(address.port));
    });
  });
}

function getStructuredContent(result: McpToolResult): StructuredContent | null {
  if (result.structuredContent && typeof result.structuredContent === "object") {
    return result.structuredContent;
  }
  const content = result.content?.[0];
  if (content && typeof content === "object" && "structuredContent" in content) {
    const structured = (content as { structuredContent?: StructuredContent }).structuredContent;
    if (structured) return structured;
  }
  if (content && typeof content === "object") {
    return content as StructuredContent;
  }
  return null;
}

async function waitForAgentCompletion(options: {
  client: McpClient;
  agentId: string;
}): Promise<void> {
  const waitResult = (await options.client.callTool({
    name: "wait_for_agent",
    args: { agentId: options.agentId },
  })) as McpToolResult;
  const payload = getStructuredContent(waitResult);
  if (!payload) {
    throw new Error("wait_for_agent returned no structured payload");
  }
  if (payload.permission) {
    throw new Error(`Unexpected permission while waiting: ${JSON.stringify(payload.permission)}`);
  }
  const status = payload.status;
  if (status === "running" || status === "initializing") {
    throw new Error(`Agent still running after wait_for_agent (status=${String(status)})`);
  }
}

describe("agent MCP end-to-end (offline)", () => {
  test(
    "create_agent runs initial prompt and affects filesystem",
    async () => {
      const junctionHome = await mkdtemp(path.join(os.tmpdir(), "junction-home-"));
      const staticDir = await mkdtemp(path.join(os.tmpdir(), "junction-static-"));
      const agentCwd = await mkdtemp(path.join(os.tmpdir(), "junction-agent-cwd-"));
      const port = await getAvailablePort();

      const daemonConfig: JunctionDaemonConfig = {
        listen: `127.0.0.1:${port}`,
        junctionHome,
        corsAllowedOrigins: [],
        allowedHosts: true,
        mcpEnabled: true,
        staticDir,
        mcpDebug: false,
        agentClients: createTestAgentClients(),
        agentStoragePath: path.join(junctionHome, "agents"),
      };

      const daemon = await createJunctionDaemon(daemonConfig, pino({ level: "silent" }));
      await daemon.start();

      const transport = new StreamableHTTPClientTransport(
        new URL(`http://127.0.0.1:${port}/mcp/agents`)
      );
      const client = (await experimental_createMCPClient({ transport })) as McpClient;

      let agentId: string | null = null;
      try {
        const filePath = path.join(agentCwd, "mcp-smoke.txt");
        await writeFile(filePath, "ok", "utf8");

        const initialPrompt = [
          "You must call the Bash command tool with the exact command `rm -f mcp-smoke.txt`.",
          "Run it and reply with done and stop.",
          "Do not respond before the command finishes.",
        ].join("\n");

        const result = (await client.callTool({
          name: "create_agent",
          args: {
            cwd: agentCwd,
            title: "MCP e2e smoke",
            agentType: "claude",
            initialMode: "bypassPermissions",
            initialPrompt,
            background: false,
          },
        })) as McpToolResult;

        const payload = getStructuredContent(result);
        agentId = (payload?.agentId as string | undefined) ?? null;
        expect(agentId).toBeTruthy();

        await waitForAgentCompletion({ client, agentId: agentId! });

        if (existsSync(filePath)) {
          const contents = await readFile(filePath, "utf8");
          throw new Error(
            `Expected mcp-smoke.txt to be removed, but it still exists with contents: ${contents}`
          );
        }
      } finally {
        if (agentId) {
          await client.callTool({ name: "kill_agent", args: { agentId } });
        }
        await client.close();
        await daemon.stop();
        await rm(junctionHome, { recursive: true, force: true });
        await rm(staticDir, { recursive: true, force: true });
        await rm(agentCwd, { recursive: true, force: true });
      }
    },
    30_000
  );

  test(
    "create_agent with worktree is async and boots terminals only after setup success",
    async () => {
      const junctionHome = await mkdtemp(path.join(os.tmpdir(), "junction-home-"));
      const staticDir = await mkdtemp(path.join(os.tmpdir(), "junction-static-"));
      const repoRoot = await mkdtemp(path.join(os.tmpdir(), "junction-worktree-repo-"));
      const port = await getAvailablePort();

      const daemonConfig: JunctionDaemonConfig = {
        listen: `127.0.0.1:${port}`,
        junctionHome,
        corsAllowedOrigins: [],
        allowedHosts: true,
        mcpEnabled: true,
        staticDir,
        mcpDebug: false,
        agentClients: createTestAgentClients(),
        agentStoragePath: path.join(junctionHome, "agents"),
      };

      const daemon = await createJunctionDaemon(daemonConfig, pino({ level: "silent" }));
      await daemon.start();

      const transport = new StreamableHTTPClientTransport(
        new URL(`http://127.0.0.1:${port}/mcp/agents`)
      );
      const client = (await experimental_createMCPClient({ transport })) as McpClient;

      let agentId: string | null = null;
      try {
        const { execSync } = await import("node:child_process");
        execSync("git init -b main", { cwd: repoRoot, stdio: "pipe" });
        execSync("git config user.email 'test@test.com'", { cwd: repoRoot, stdio: "pipe" });
        execSync("git config user.name 'Test'", { cwd: repoRoot, stdio: "pipe" });
        await writeFile(path.join(repoRoot, "file.txt"), "hello\n", "utf8");
        execSync("git add .", { cwd: repoRoot, stdio: "pipe" });
        execSync("git -c commit.gpgsign=false commit -m 'initial'", { cwd: repoRoot, stdio: "pipe" });

        const setupCommand =
          'while [ ! -f "$JUNCTION_WORKTREE_PATH/allow-setup" ]; do sleep 0.05; done; echo "done" > "$JUNCTION_WORKTREE_PATH/setup-done.txt"';
        await writeFile(
          path.join(repoRoot, "junction.json"),
          JSON.stringify({
            worktree: {
              setup: [setupCommand],
              terminals: [
                {
                  name: "Dev Server",
                  command: 'echo "dev-server" > dev-terminal.txt; tail -f /dev/null',
                },
              ],
            },
          }),
          "utf8"
        );
        execSync("git add junction.json", { cwd: repoRoot, stdio: "pipe" });
        execSync("git -c commit.gpgsign=false commit -m 'add worktree config'", {
          cwd: repoRoot,
          stdio: "pipe",
        });

        const result = (await withTimeout({
          promise: client.callTool({
            name: "create_agent",
            args: {
              cwd: repoRoot,
              title: "MCP worktree setup terminals",
              agentType: "claude",
              initialMode: "bypassPermissions",
              initialPrompt: "say done and stop",
              worktreeName: "mcp-worktree-setup-test",
              baseBranch: "main",
              background: true,
            },
          }),
          timeoutMs: 2500,
          label: "create_agent should not block on setup",
        })) as McpToolResult;

        const payload = getStructuredContent(result);
        agentId = (payload?.agentId as string | undefined) ?? null;
        expect(agentId).toBeTruthy();
        const worktreePath = (payload?.cwd as string | undefined) ?? "";
        expect(worktreePath).toContain(`${path.sep}worktrees${path.sep}`);
        expect(existsSync(path.join(worktreePath, "setup-done.txt"))).toBe(false);
        expect(existsSync(path.join(worktreePath, "dev-terminal.txt"))).toBe(false);

        await writeFile(path.join(worktreePath, "allow-setup"), "ok\n", "utf8");

        await waitForPathExists({
          targetPath: path.join(worktreePath, "setup-done.txt"),
          timeoutMs: 15000,
        });
        await waitForPathExists({
          targetPath: path.join(worktreePath, "dev-terminal.txt"),
          timeoutMs: 30000,
        });
      } finally {
        if (agentId) {
          await client.callTool({ name: "kill_agent", args: { agentId } });
        }
        await client.close();
        await daemon.stop();
        await rm(junctionHome, { recursive: true, force: true });
        await rm(staticDir, { recursive: true, force: true });
        await rm(repoRoot, { recursive: true, force: true });
      }
    },
    60_000
  );
});

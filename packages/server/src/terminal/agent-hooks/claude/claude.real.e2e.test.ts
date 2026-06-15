import { spawnSync } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import * as pty from "node-pty";
import { afterEach, describe, expect, it } from "vitest";
import { resolvePaseoCliBinDir } from "../../terminal.js";
import { installRegisteredAgentHooks } from "../provider-registry.js";

interface ActivityPost {
  terminalId: string;
  token: string;
  state: string;
}

interface ClaudeAvailability {
  available: boolean;
  detail: string;
}

const temporaryDirs: string[] = [];
const claudeAvailability = checkClaudeAvailability();

afterEach(() => {
  while (temporaryDirs.length > 0) {
    const dir = temporaryDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function checkClaudeAvailability(): ClaudeAvailability {
  const which = spawnSync("/bin/sh", ["-lc", "command -v claude"], {
    encoding: "utf8",
  });
  const claudePath = which.stdout.trim();
  if (which.status !== 0 || !claudePath) {
    return { available: false, detail: "real claude binary is not installed on PATH" };
  }

  const version = spawnSync(claudePath, ["--version"], {
    encoding: "utf8",
    timeout: 10_000,
  });
  if (version.status !== 0) {
    return {
      available: false,
      detail: `real claude --version failed: ${(version.stderr || version.stdout).trim()}`,
    };
  }

  return {
    available: true,
    detail: `${claudePath} ${(version.stdout || version.stderr).trim()}`,
  };
}

function createTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirs.push(dir);
  return dir;
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

async function createActivityRecorder() {
  const posts: ActivityPost[] = [];
  const server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
    if (request.method !== "POST" || request.url !== "/api/terminal-activity") {
      response.statusCode = 404;
      response.end();
      return;
    }

    const body = await readBody(request);
    posts.push(JSON.parse(body) as ActivityPost);
    response.statusCode = 200;
    response.end("ok");
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected TCP activity recorder address");
  }

  return {
    posts,
    url: `http://127.0.0.1:${address.port}/api/terminal-activity`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function waitForExit(process: pty.IPty, timeoutMs: number): Promise<{ exitCode: number | null }> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      process.kill();
      reject(new Error(`Timed out waiting for claude after ${timeoutMs}ms`));
    }, timeoutMs);

    process.onExit((event) => {
      clearTimeout(timeout);
      resolve({ exitCode: event.exitCode });
    });
  });
}

function statesFor(posts: ActivityPost[], terminalId: string, token: string): string[] {
  return posts
    .filter((post) => post.terminalId === terminalId && post.token === token)
    .map((post) => post.state);
}

describe.skipIf(!claudeAvailability.available)(
  `real Claude terminal activity hooks (${claudeAvailability.detail})`,
  () => {
    it("posts running then idle through the installed Claude config hooks", async () => {
      const recorder = await createActivityRecorder();
      const terminalId = "real-claude-terminal";
      const token = "real-claude-token";
      const configDir = createTempDir("paseo-real-claude-config-");
      const cwd = createTempDir("paseo-real-claude-cwd-");
      const paseoCliBinDir = resolvePaseoCliBinDir();
      if (!paseoCliBinDir) {
        throw new Error("Could not resolve paseo CLI bin directory");
      }

      installRegisteredAgentHooks({ configDir });

      try {
        const claude = pty.spawn(
          "claude",
          ["--settings", join(configDir, "settings.json"), "-p", "reply with: done"],
          {
            name: "xterm-256color",
            cols: 80,
            rows: 24,
            cwd,
            env: {
              ...process.env,
              PASEO_TERMINAL_ID: terminalId,
              PASEO_ACTIVITY_TOKEN: token,
              PASEO_TERMINAL_ACTIVITY_URL: recorder.url,
              PATH: [paseoCliBinDir, process.env.PATH].filter(isString).join(delimiter),
            },
          },
        );

        const output: string[] = [];
        claude.onData((data) => output.push(data));
        const exit = await waitForExit(claude, 90_000);
        expect(exit.exitCode, output.join("")).toBe(0);

        const states = statesFor(recorder.posts, terminalId, token);
        expect(states).toContain("running");
        expect(states).toContain("idle");
        expect(states.indexOf("running")).toBeLessThan(states.lastIndexOf("idle"));
      } finally {
        await recorder.close();
      }
    }, 100_000);
  },
);

function isString(value: string | undefined): value is string {
  return typeof value === "string" && value.length > 0;
}

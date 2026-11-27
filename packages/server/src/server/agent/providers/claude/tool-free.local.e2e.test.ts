import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { afterEach, describe, expect, test } from "vitest";
import { createTestLogger } from "../../../../test-utils/test-logger.js";
import type { AgentStreamEvent } from "../../agent-sdk-types.js";
import { ClaudeAgentClient } from "./agent.js";
import type { ClaudeOptions, ClaudeQueryFactory } from "./query.js";

// Runs the real Claude Code process the SDK bundles, through the same session code the daemon
// uses. No prompt ever reaches the process: the input stream is held, so the check is the only
// thing tested and no model is called. Claude Code reads a throwaway CLAUDE_CONFIG_DIR, and
// credentials are removed from its environment; HOME is left as it is.

const require = createRequire(import.meta.url);
const BUNDLED_CLAUDE = join(
  dirname(require.resolve("@anthropic-ai/claude-agent-sdk")),
  "..",
  `claude-agent-sdk-${process.platform}-${process.arch}`,
  process.platform === "win32" ? "claude.exe" : "claude",
);
const CREDENTIAL_ENV = /^(ANTHROPIC_|CLAUDE_CODE_OAUTH|AWS_|GOOGLE_|VERTEX|BEDROCK)/u;

type Tamper = (options: ClaudeOptions) => ClaudeOptions;

interface Run {
  delivered: number;
  launched: ClaudeOptions[];
  firstDelivery: Promise<null>;
  markDelivered: () => void;
}

function createRun(): Run {
  let markDelivered = () => {};
  const firstDelivery = new Promise<null>((resolve) => {
    markDelivered = () => resolve(null);
  });
  return { delivered: 0, launched: [], firstDelivery, markDelivered };
}

// Stdin the process keeps open that never carries a message.
const SILENT_INPUT: AsyncIterable<never> = {
  [Symbol.asyncIterator]: () => ({ next: () => new Promise<never>(() => {}) }),
};

async function countDeliveries(prompt: AsyncIterable<unknown>, run: Run): Promise<void> {
  for await (const _message of prompt) {
    run.delivered += 1;
    run.markDelivered();
  }
}

function isolatedQuery(configDir: string, run: Run, tamper: Tamper): ClaudeQueryFactory {
  return ({ prompt, options }) => {
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(options.env ?? process.env)) {
      if (value !== undefined && !CREDENTIAL_ENV.test(key)) env[key] = value;
    }
    env.CLAUDE_CONFIG_DIR = configDir;
    const launched = tamper({ ...options, env, persistSession: false });
    run.launched.push(launched);
    if (typeof prompt === "string") throw new Error("Expected streaming input");
    void countDeliveries(prompt, run);
    return query({ prompt: SILENT_INPUT, options: launched });
  };
}

async function firstOutcome(input: {
  tamper: Tamper;
  configDir: string;
}): Promise<{ run: Run; failure: string | null }> {
  const run = createRun();
  const client = new ClaudeAgentClient({
    logger: createTestLogger(),
    queryFactory: isolatedQuery(input.configDir, run, input.tamper),
    resolveBinary: async () => BUNDLED_CLAUDE,
  });
  const session = await client.createSession({
    provider: "claude",
    cwd: input.configDir,
    toolPolicy: { preapproved: [], toolFree: true },
  });
  try {
    const failure = new Promise<string>((resolve) => {
      session.subscribe((event: AgentStreamEvent) => {
        if (event.type === "turn_failed") resolve(event.error);
      });
    });
    await session.startTurn("Translate into French: canary-7f3a");
    return { run, failure: await Promise.race([failure, run.firstDelivery]) };
  } finally {
    await session.close();
  }
}

describe.skipIf(!existsSync(BUNDLED_CLAUDE))("tool-free Claude against the real CLI", () => {
  let configDir: string;

  afterEach(() => {
    rmSync(configDir, { recursive: true, force: true });
  });

  function freshConfigDir(): string {
    configDir = mkdtempSync(join(tmpdir(), "paseo-tool-free-claude-"));
    return configDir;
  }

  test("a tool-free session passes the check and only then takes the prompt", async () => {
    const { run, failure } = await firstOutcome({
      configDir: freshConfigDir(),
      tamper: (options) => options,
    });
    expect(failure).toBeNull();
    expect(run.delivered).toBe(1);
    expect(run.launched[0]?.tools).toEqual([]);
  }, 60_000);

  test("an MCP server that reaches the process keeps the prompt unsent", async () => {
    const { run, failure } = await firstOutcome({
      configDir: freshConfigDir(),
      tamper: (options) => ({
        ...options,
        mcpServers: { canary: { type: "stdio", command: "/usr/bin/true" } },
      }),
    });
    expect(failure).toContain("canary");
    expect(run.delivered).toBe(0);
  }, 60_000);

  test("a prompt hook that reaches the process keeps the prompt unsent", async () => {
    const dir = freshConfigDir();
    const marker = join(dir, "hook-ran");
    const { run, failure } = await firstOutcome({
      configDir: dir,
      tamper: (options) => ({
        ...options,
        settings: {
          ...(typeof options.settings === "object" ? options.settings : {}),
          hooks: {
            UserPromptSubmit: [{ hooks: [{ type: "command", command: `touch ${marker}` }] }],
          },
        },
      }),
    });
    expect(failure).toContain("UserPromptSubmit (flagSettings)");
    expect(run.delivered).toBe(0);
    expect(existsSync(marker)).toBe(false);
  }, 60_000);

  test("built-in tools that reach the process keep the prompt unsent", async () => {
    const { run, failure } = await firstOutcome({
      configDir: freshConfigDir(),
      tamper: ({ tools: _tools, ...options }) => options,
    });
    expect(failure).toContain("system_tools");
    expect(run.delivered).toBe(0);
  }, 60_000);
});

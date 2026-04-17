import { describe, expect, test } from "vitest";

import { resolveStructuredHelperMcpServers, resolveStructuredHelperProviders } from "./session.js";

describe("resolveStructuredHelperMcpServers", () => {
  test("prefers a running agent in the same cwd when it has MCP servers", () => {
    const expected = {
      task_board_mcp: { type: "http", url: "http://127.0.0.1:6767/mcp/task-board" },
    };

    const result = resolveStructuredHelperMcpServers({
      cwd: "C:/workspace/app",
      agents: [
        {
          cwd: "C:/workspace/app",
          lifecycle: "idle",
          updatedAt: new Date("2026-04-17T09:00:00.000Z"),
          config: {
            provider: "codex",
            cwd: "C:/workspace/app",
            mcpServers: {
              paseo: { type: "http", url: "http://127.0.0.1:6767/mcp" },
            },
          },
        },
        {
          cwd: "C:/workspace/app",
          lifecycle: "running",
          updatedAt: new Date("2026-04-17T08:00:00.000Z"),
          config: {
            provider: "codex",
            cwd: "C:/workspace/app",
            mcpServers: expected,
          },
        },
      ],
    });

    expect(result).toEqual(expected);
  });

  test("ignores agents from other working directories", () => {
    const result = resolveStructuredHelperMcpServers({
      cwd: "C:/workspace/app",
      agents: [
        {
          cwd: "C:/workspace/other",
          lifecycle: "running",
          updatedAt: new Date("2026-04-17T08:00:00.000Z"),
          config: {
            provider: "codex",
            cwd: "C:/workspace/other",
            mcpServers: {
              task_board_mcp: { type: "http", url: "http://127.0.0.1:6767/mcp/task-board" },
            },
          },
        },
      ],
    });

    expect(result).toBeUndefined();
  });

  test("returns undefined when no matching agent exposes MCP servers", () => {
    const result = resolveStructuredHelperMcpServers({
      cwd: "C:/workspace/app",
      agents: [
        {
          cwd: "C:/workspace/app",
          lifecycle: "running",
          updatedAt: new Date("2026-04-17T08:00:00.000Z"),
          config: {
            provider: "codex",
            cwd: "C:/workspace/app",
          },
        },
      ],
    });

    expect(result).toBeUndefined();
  });
});

describe("resolveStructuredHelperProviders", () => {
  test("uses default structured helper order when no helper preferences are configured", () => {
    expect(resolveStructuredHelperProviders()).toEqual([
      { provider: "claude", model: "haiku" },
      { provider: "codex", model: "gpt-5.4-mini", thinkingOptionId: "low" },
      { provider: "opencode", model: "opencode/gpt-5-nano" },
    ]);
  });

  test("respects configured provider order and model overrides", () => {
    expect(
      resolveStructuredHelperProviders({
        helperProviders: [
          { provider: "codex", model: "gpt-5.4" },
          { provider: "claude", model: null },
        ],
      }),
    ).toEqual([
      { provider: "codex", model: "gpt-5.4", thinkingOptionId: "low" },
      { provider: "claude", model: "haiku" },
    ]);
  });
});

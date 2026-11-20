import { describe, expect, it } from "vitest";
import {
  negotiateProviderCapabilities,
  ProviderInputSchema,
  requiredProviderCapabilities,
  requireProviderCapabilities,
  type ProviderInput,
} from "./provider.js";

type ReviewMode = "uncommitted" | "base" | "all";
type Delivery = "auto" | "steer";

const contextLine = {
  oldLineNumber: null,
  newLineNumber: 12,
  type: "add",
  content: "const value = 1;",
} as const;

it("negotiates optional integration support independently from required tool policies", () => {
  expect(
    negotiateProviderCapabilities(
      [
        "mcp.http",
        "session.system_prompt",
        "permission.optional_tool_policy",
        "permission.tool_policy",
      ],
      ["mcp.http", "session.system_prompt", "permission.optional_tool_policy"],
    ),
  ).toEqual(["mcp.http", "session.system_prompt", "permission.optional_tool_policy"]);
});

it("requires explicit optional-policy support without making required tool policy optional", () => {
  const input = ProviderInputSchema.parse({
    type: "session.open",
    requestId: "open-1",
    sessionId: "session-1",
    config: {
      cwd: "/workspace",
      env: {},
      mcpServers: { memory: { type: "http", url: "http://127.0.0.1/memory" } },
      toolPolicy: { preapproved: [{ kind: "mcp", server: "memory", tool: "required" }] },
      pluginToolPolicy: { preapproved: [{ kind: "mcp", server: "memory", tool: "read" }] },
      settings: {},
      persist: true,
    },
    history: "skip",
  });
  expect(requiredProviderCapabilities(input)).toEqual([
    "permission.tool_policy",
    "permission.optional_tool_policy",
  ]);
  expect(() => requireProviderCapabilities(["permission.tool_policy"], input)).toThrow(
    "Provider does not support permission.optional_tool_policy",
  );
  expect(() => requireProviderCapabilities(["permission.optional_tool_policy"], input)).toThrow(
    "Provider does not support permission.tool_policy",
  );
});

function reviewPrompt(mode: ReviewMode, delivery: Delivery): ProviderInput {
  return {
    type: "session.prompt",
    sessionId: "session-1",
    prompt: {
      clientMessageId: "message-1",
      delivery,
      input: {
        type: "message",
        content: [
          {
            type: "review",
            mimeType: "application/paseo-review",
            cwd: "/workspace",
            mode,
            baseRef: "main",
            comments: [
              {
                filePath: "src/index.ts",
                side: "new",
                lineNumber: 12,
                body: "Please review this change.",
                context: {
                  hunkHeader: "@@ -10,2 +10,3 @@",
                  targetLine: contextLine,
                  lines: [{ ...contextLine, type: "context", oldLineNumber: 11 }, contextLine],
                },
              },
            ],
          },
        ],
      },
    },
  };
}

describe("Provider review attachments", () => {
  it.each(["uncommitted", "base", "all"] as const)(
    "preserves mode %s on an ordinary prompt",
    (mode) => {
      const input = reviewPrompt(mode, "auto");
      expect(ProviderInputSchema.parse(input)).toEqual(input);
    },
  );

  it.each(["uncommitted", "base", "all"] as const)(
    "preserves mode %s on a steering prompt",
    (mode) => {
      const input = reviewPrompt(mode, "steer");
      expect(ProviderInputSchema.parse(input)).toEqual(input);
    },
  );
});

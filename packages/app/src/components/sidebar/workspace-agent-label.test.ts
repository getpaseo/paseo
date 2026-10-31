import { describe, expect, it } from "vitest";
import type { ProviderSnapshotEntry } from "@getpaseo/protocol/agent-types";
import { formatWorkspaceAgentLabel } from "./workspace-agent-label";

const entries: ProviderSnapshotEntry[] = [
  {
    provider: "claude",
    status: "ready",
    enabled: true,
    label: "Claude Code",
    models: [{ provider: "claude", id: "claude-opus-5-5", aliases: ["opus"], label: "Opus 5.5" }],
  },
];

describe("formatWorkspaceAgentLabel", () => {
  it("names the provider and the model by their labels", () => {
    expect(formatWorkspaceAgentLabel("claude", "claude-opus-5-5", entries)).toBe(
      "Claude Code · Opus 5.5",
    );
  });

  it("matches a model by alias", () => {
    expect(formatWorkspaceAgentLabel("claude", "opus", entries)).toBe("Claude Code · Opus 5.5");
  });

  it("falls back to the raw ids before the snapshot arrives", () => {
    expect(formatWorkspaceAgentLabel("codex", "gpt-6-luna", undefined)).toBe("codex · gpt-6-luna");
  });

  it("shows only the provider when the agent has no model", () => {
    expect(formatWorkspaceAgentLabel("claude", null, entries)).toBe("Claude Code");
  });
});

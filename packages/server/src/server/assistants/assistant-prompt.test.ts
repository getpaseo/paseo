import { describe, expect, test } from "vitest";
import { AssistantSchema } from "@getpaseo/protocol/messages";
import { buildAssistantInitialPrompt } from "./assistant-prompt.js";

describe("buildAssistantInitialPrompt", () => {
  test("injects only the assistant memory summary, not the full memory", () => {
    const assistant = AssistantSchema.parse({
      id: "assistant-1",
      name: "Reviewer",
      description: "Reviews code",
      prompt: "Review carefully.",
      memoryEnabled: true,
      memory: "FULL_DETAIL_SECRET: prefer the internal migration plan.",
      memorySummary:
        "# Assistant memory summary\n\nDetail file index:\n1. detail-001 — Migration plan\n   Path: /tmp/assistant-memory/detail-001.md",
      memoryFiles: {
        summaryPath: "/tmp/assistant-memory/summary.md",
        detailFiles: [
          {
            id: "detail-001",
            title: "Migration plan",
            path: "/tmp/assistant-memory/detail-001.md",
            charCount: 52,
          },
        ],
      },
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });

    const prompt = buildAssistantInitialPrompt(assistant, "Please review this diff.");

    expect(prompt).toContain("Review carefully.");
    expect(prompt).toContain("Assistant memory summary");
    expect(prompt).toContain("/tmp/assistant-memory/detail-001.md");
    expect(prompt).toContain("Please review this diff.");
    expect(prompt).not.toContain("FULL_DETAIL_SECRET");
  });
});

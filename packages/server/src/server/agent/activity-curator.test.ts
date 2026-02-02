import { describe, test, expect } from "vitest";
import { curateAgentActivity } from "./activity-curator.js";
import type { AgentTimelineItem } from "./agent-sdk-types.js";

describe("curateAgentActivity", () => {
  describe("serializes all timeline item types", () => {
    test("serializes user_message", () => {
      const timeline: AgentTimelineItem[] = [
        { type: "user_message", text: "Hello, can you help me?" },
      ];

      const result = curateAgentActivity(timeline);

      expect(result).toBe("[User] Hello, can you help me?");
    });

    test("serializes assistant_message", () => {
      const timeline: AgentTimelineItem[] = [
        { type: "assistant_message", text: "I can help you with that." },
      ];

      const result = curateAgentActivity(timeline);

      expect(result).toBe("I can help you with that.");
    });

    test("serializes reasoning as [Thought]", () => {
      const timeline: AgentTimelineItem[] = [
        { type: "reasoning", text: "The user wants to understand X." },
      ];

      const result = curateAgentActivity(timeline);

      expect(result).toBe("[Thought] The user wants to understand X.");
    });

    test("serializes tool_call with name", () => {
      const timeline: AgentTimelineItem[] = [
        {
          type: "tool_call",
          callId: "call-1",
          name: "Read",
          input: { file_path: "/src/index.ts" },
          status: "completed",
        },
      ];

      const result = curateAgentActivity(timeline);

      expect(result).toBe("[Read] /src/index.ts");
    });

    test("serializes tool_call without principal param", () => {
      const timeline: AgentTimelineItem[] = [
        {
          type: "tool_call",
          callId: "call-1",
          name: "ListFiles",
          input: {},
          status: "completed",
        },
      ];

      const result = curateAgentActivity(timeline);

      expect(result).toBe("[ListFiles]");
    });

    test("serializes todo items as [Tasks]", () => {
      const timeline: AgentTimelineItem[] = [
        {
          type: "todo",
          items: [
            { text: "Read the file", completed: true },
            { text: "Fix the bug", completed: false },
            { text: "Run tests", completed: false },
          ],
        },
      ];

      const result = curateAgentActivity(timeline);

      expect(result).toContain("[Tasks]");
      expect(result).toContain("- [x] Read the file");
      expect(result).toContain("- [ ] Fix the bug");
      expect(result).toContain("- [ ] Run tests");
    });

    test("serializes error items", () => {
      const timeline: AgentTimelineItem[] = [
        { type: "error", message: "File not found: /missing.ts" },
      ];

      const result = curateAgentActivity(timeline);

      expect(result).toBe("[Error] File not found: /missing.ts");
    });
  });

  describe("handles complex conversations", () => {
    test("serializes full conversation with multiple item types", () => {
      const timeline: AgentTimelineItem[] = [
        { type: "user_message", text: "Fix the bug in auth.ts" },
        { type: "reasoning", text: "I need to read the file first." },
        {
          type: "tool_call",
          callId: "call-1",
          name: "Read",
          input: { file_path: "/src/auth.ts" },
          status: "completed",
        },
        { type: "assistant_message", text: "I found the issue." },
        {
          type: "tool_call",
          callId: "call-2",
          name: "Edit",
          input: { file_path: "/src/auth.ts", old_string: "bug", new_string: "fix" },
          status: "completed",
        },
        { type: "assistant_message", text: "The bug has been fixed." },
      ];

      const result = curateAgentActivity(timeline);

      expect(result).toContain("[User] Fix the bug in auth.ts");
      expect(result).toContain("[Thought] I need to read the file first.");
      expect(result).toContain("[Read] /src/auth.ts");
      expect(result).toContain("I found the issue.");
      expect(result).toContain("[Edit] /src/auth.ts");
      expect(result).toContain("The bug has been fixed.");
    });

    test("preserves order of items", () => {
      const timeline: AgentTimelineItem[] = [
        { type: "user_message", text: "Step 1" },
        { type: "assistant_message", text: "Step 2" },
        { type: "user_message", text: "Step 3" },
        { type: "assistant_message", text: "Step 4" },
      ];

      const result = curateAgentActivity(timeline);
      const lines = result.split("\n");

      expect(lines[0]).toContain("Step 1");
      expect(lines[1]).toContain("Step 2");
      expect(lines[2]).toContain("Step 3");
      expect(lines[3]).toContain("Step 4");
    });
  });

  describe("handles edge cases", () => {
    test("returns default message for empty timeline", () => {
      const result = curateAgentActivity([]);

      expect(result).toBe("No activity to display.");
    });

    test("handles whitespace-only messages", () => {
      const timeline: AgentTimelineItem[] = [
        { type: "user_message", text: "  \n  " },
        { type: "assistant_message", text: "Real message" },
      ];

      const result = curateAgentActivity(timeline);

      expect(result).toContain("Real message");
    });

    test("trims whitespace from messages", () => {
      const timeline: AgentTimelineItem[] = [
        { type: "user_message", text: "  Hello  \n" },
      ];

      const result = curateAgentActivity(timeline);

      expect(result).toBe("[User] Hello");
    });
  });

  describe("collapsing behavior", () => {
    test("merges consecutive assistant_message items", () => {
      const timeline: AgentTimelineItem[] = [
        { type: "assistant_message", text: "Part 1. " },
        { type: "assistant_message", text: "Part 2. " },
        { type: "assistant_message", text: "Part 3." },
      ];

      const result = curateAgentActivity(timeline);

      expect(result).toBe("Part 1. Part 2. Part 3.");
    });

    test("merges consecutive reasoning items", () => {
      const timeline: AgentTimelineItem[] = [
        { type: "reasoning", text: "First thought. " },
        { type: "reasoning", text: "Second thought." },
      ];

      const result = curateAgentActivity(timeline);

      expect(result).toBe("[Thought] First thought. Second thought.");
    });

    test("deduplicates tool calls by callId", () => {
      const timeline: AgentTimelineItem[] = [
        {
          type: "tool_call",
          callId: "call-1",
          name: "Read",
          input: { file_path: "/src/a.ts" },
          status: "pending",
        },
        {
          type: "tool_call",
          callId: "call-1",
          name: "Read",
          input: { file_path: "/src/a.ts" },
          status: "completed",
        },
      ];

      const result = curateAgentActivity(timeline);

      // Should only appear once
      const matches = result.match(/\[Read\]/g);
      expect(matches?.length).toBe(1);
    });
  });

  describe("maxItems limit", () => {
    test("respects maxItems option", () => {
      const timeline: AgentTimelineItem[] = [
        { type: "user_message", text: "Message 1" },
        { type: "user_message", text: "Message 2" },
        { type: "user_message", text: "Message 3" },
        { type: "user_message", text: "Message 4" },
        { type: "user_message", text: "Message 5" },
      ];

      const result = curateAgentActivity(timeline, { maxItems: 3 });

      // Should only have the last 3 messages
      expect(result).not.toContain("Message 1");
      expect(result).not.toContain("Message 2");
      expect(result).toContain("Message 3");
      expect(result).toContain("Message 4");
      expect(result).toContain("Message 5");
    });

    test("uses default maxItems of 40", () => {
      const timeline: AgentTimelineItem[] = [];
      for (let i = 0; i < 50; i++) {
        timeline.push({ type: "user_message", text: `Message ${i}` });
      }

      const result = curateAgentActivity(timeline);

      // First 10 should be truncated
      expect(result).not.toContain("Message 0");
      expect(result).not.toContain("Message 9");
      // Last 40 should be present
      expect(result).toContain("Message 10");
      expect(result).toContain("Message 49");
    });
  });

  describe("tool call principal extraction", () => {
    test("extracts file_path from Read tool", () => {
      const timeline: AgentTimelineItem[] = [
        {
          type: "tool_call",
          callId: "1",
          name: "Read",
          input: { file_path: "/src/index.ts" },
          status: "completed",
        },
      ];

      const result = curateAgentActivity(timeline);

      expect(result).toBe("[Read] /src/index.ts");
    });

    test("extracts command from Bash tool", () => {
      const timeline: AgentTimelineItem[] = [
        {
          type: "tool_call",
          callId: "1",
          name: "Bash",
          input: { command: "npm test" },
          status: "completed",
        },
      ];

      const result = curateAgentActivity(timeline);

      expect(result).toBe("[Bash] npm test");
    });

    test("extracts pattern from Glob tool", () => {
      const timeline: AgentTimelineItem[] = [
        {
          type: "tool_call",
          callId: "1",
          name: "Glob",
          input: { pattern: "**/*.ts" },
          status: "completed",
        },
      ];

      const result = curateAgentActivity(timeline);

      expect(result).toBe("[Glob] **/*.ts");
    });

    test("extracts pattern from Grep tool", () => {
      const timeline: AgentTimelineItem[] = [
        {
          type: "tool_call",
          callId: "1",
          name: "Grep",
          input: { pattern: "TODO" },
          status: "completed",
        },
      ];

      const result = curateAgentActivity(timeline);

      expect(result).toBe("[Grep] TODO");
    });
  });
});

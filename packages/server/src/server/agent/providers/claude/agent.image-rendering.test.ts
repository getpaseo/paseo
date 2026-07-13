import { existsSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, test } from "vitest";

import { createTestLogger } from "../../../../test-utils/test-logger.js";
import type { AgentStreamEvent, AgentTimelineItem } from "../../agent-sdk-types.js";
import { ClaudeAgentClient } from "./agent.js";

const ONE_BY_ONE_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+X1r0AAAAASUVORK5CYII=";
const MATERIALIZED_PNG_PATH_PATTERN =
  /paseo-attachments(?:-[^\\/]+)?[\\/](?:[^\\/]+[\\/])?[0-9a-f]{64}\.png$/;

interface ClaudeImageTestSession {
  translateMessageToEvents(message: SDKMessage): AgentStreamEvent[];
  convertHistoryEntry(entry: unknown): AgentTimelineItem[];
}

async function createSession(): Promise<ClaudeImageTestSession> {
  const client = new ClaudeAgentClient({
    logger: createTestLogger(),
    resolveBinary: async () => "/test/claude/bin",
  });
  const session = await client.createSession({ provider: "claude", cwd: process.cwd() });
  return session as unknown as ClaudeImageTestSession;
}

function imageToolResultUserMessage(): SDKMessage {
  return {
    type: "user",
    parent_tool_use_id: null,
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "toolu_read_png",
          tool_name: "Read",
          content: [
            {
              type: "image",
              source: {
                type: "base64",
                media_type: "image/png",
                data: ONE_BY_ONE_PNG_BASE64,
              },
            },
          ],
        },
      ],
    },
    uuid: "user-image-result-1",
    session_id: "session-1",
  } as unknown as SDKMessage;
}

function imageToolResultHistoryEntry(): unknown {
  return {
    type: "user",
    uuid: "user-image-result-1",
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "toolu_read_png",
          tool_name: "Read",
          content: [
            {
              type: "image",
              source: {
                type: "base64",
                media_type: "image/png",
                data: ONE_BY_ONE_PNG_BASE64,
              },
            },
          ],
        },
      ],
    },
  };
}

function erroredImageToolResultUserMessage(): SDKMessage {
  return {
    type: "user",
    parent_tool_use_id: null,
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "toolu_read_png",
          tool_name: "Read",
          is_error: true,
          content: [
            {
              type: "image",
              source: {
                type: "base64",
                media_type: "image/png",
                data: ONE_BY_ONE_PNG_BASE64,
              },
            },
          ],
        },
      ],
    },
    uuid: "user-image-error-1",
    session_id: "session-1",
  } as unknown as SDKMessage;
}

function multiImageToolResultUserMessage(): SDKMessage {
  const imageBlock = {
    type: "image",
    source: { type: "base64", media_type: "image/png", data: ONE_BY_ONE_PNG_BASE64 },
  };
  return {
    type: "user",
    parent_tool_use_id: null,
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "toolu_read_png",
          tool_name: "Read",
          content: [imageBlock, imageBlock],
        },
      ],
    },
    uuid: "user-image-result-multi",
    session_id: "session-1",
  } as unknown as SDKMessage;
}

function imageMessages(items: AgentTimelineItem[]): string[] {
  return items
    .filter((item) => item.type === "assistant_message")
    .map((item) => (item as { text: string }).text)
    .filter((text) => text.startsWith("!["));
}

function markdownImageSource(markdown: string): string {
  const match = markdown.match(/^!\[[^\]]*]\((.*)\)$/);
  if (!match) {
    throw new Error(`Expected markdown image, got: ${markdown}`);
  }
  // Reverse escapeMarkdownImageSource: "\\" -> "\" and "\)" -> ")" (Windows paths are escaped).
  const source = match[1].replace(/\\(.)/g, "$1");
  return source.startsWith("file://") ? fileURLToPath(source) : source;
}

describe("Claude tool_result image rendering", () => {
  test("emits the image as assistant markdown and keeps base64 out of the live tool output", async () => {
    const session = await createSession();

    const events = session.translateMessageToEvents(imageToolResultUserMessage());

    const timelineItems = events
      .filter((event) => event.type === "timeline")
      .map((event) => (event as { item: AgentTimelineItem }).item);
    const [imageMessage, ...extraImages] = imageMessages(timelineItems);
    expect(extraImages).toEqual([]);

    let source: string | undefined;
    try {
      source = markdownImageSource(imageMessage);
      expect(source).toMatch(MATERIALIZED_PNG_PATH_PATTERN);
      expect(existsSync(source)).toBe(true);
      expect(JSON.stringify(events)).not.toContain(ONE_BY_ONE_PNG_BASE64);
    } finally {
      if (source) {
        rmSync(source, { force: true });
      }
    }
  });

  test("replays the image as assistant markdown through history conversion", async () => {
    const session = await createSession();

    const items = session.convertHistoryEntry(imageToolResultHistoryEntry());

    const [imageMessage, ...extraImages] = imageMessages(items);
    expect(extraImages).toEqual([]);

    let source: string | undefined;
    try {
      source = markdownImageSource(imageMessage);
      expect(source).toMatch(MATERIALIZED_PNG_PATH_PATTERN);
      expect(existsSync(source)).toBe(true);
      expect(JSON.stringify(items)).not.toContain(ONE_BY_ONE_PNG_BASE64);
    } finally {
      if (source) {
        rmSync(source, { force: true });
      }
    }
  });

  test("keeps base64 out of an errored tool_result that carries an image", async () => {
    const session = await createSession();

    const events = session.translateMessageToEvents(erroredImageToolResultUserMessage());

    const timelineItems = events
      .filter((event) => event.type === "timeline")
      .map((event) => (event as { item: AgentTimelineItem }).item);
    const [imageMessage, ...extraImages] = imageMessages(timelineItems);
    expect(extraImages).toEqual([]);

    let source: string | undefined;
    try {
      source = markdownImageSource(imageMessage);
      expect(existsSync(source)).toBe(true);
      expect(JSON.stringify(events)).not.toContain(ONE_BY_ONE_PNG_BASE64);
      expect(JSON.stringify(events)).toContain("[image]");
    } finally {
      if (source) {
        rmSync(source, { force: true });
      }
    }
  });

  test("emits one image message per image block in a multi-image tool_result", async () => {
    const session = await createSession();

    const events = session.translateMessageToEvents(multiImageToolResultUserMessage());

    const timelineItems = events
      .filter((event) => event.type === "timeline")
      .map((event) => (event as { item: AgentTimelineItem }).item);
    const sources = imageMessages(timelineItems).map(markdownImageSource);

    try {
      expect(sources).toHaveLength(2);
      // Identical bytes materialize to one content-hashed file (idempotent), one message per block.
      expect(new Set(sources).size).toBe(1);
      expect(existsSync(sources[0])).toBe(true);
      expect(JSON.stringify(events)).not.toContain(ONE_BY_ONE_PNG_BASE64);
    } finally {
      for (const source of sources) {
        rmSync(source, { force: true });
      }
    }
  });
});

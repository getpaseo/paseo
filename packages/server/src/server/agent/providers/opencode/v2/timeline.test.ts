import type { SessionMessageAssistant } from "@opencode/client";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { V2Timeline } from "./timeline.js";

function assistant(content: SessionMessageAssistant["content"]): SessionMessageAssistant {
  return {
    id: "answer",
    type: "assistant",
    agent: "build",
    model: { providerID: "test", id: "model" },
    time: { created: 2 },
    content,
  };
}

test("a completed edit carries the replaced and replacement text", () => {
  // Captured from OpenCode 2.0.18, whose edit tool takes `path` instead of `filePath`.
  const edit = assistant([
    {
      type: "tool",
      id: "call-edit",
      name: "edit",
      executed: false,
      state: {
        status: "completed",
        input: { path: "a.txt", oldString: "beta", newString: "BETA" },
        content: [{ type: "text", text: "Edited a.txt (1 replacement)" }],
        metadata: {
          files: [
            {
              file: "a.txt",
              patch:
                "Index: a.txt\n===================================================================\n--- a.txt\n+++ a.txt\n@@ -1,3 +1,3 @@\n alpha\n-beta\n+BETA\n gamma\n",
              status: "modified",
              additions: 1,
              deletions: 1,
            },
          ],
          truncated: false,
        },
      },
      time: { created: 2, ran: 2, completed: 2 },
    },
  ]);

  expect(new V2Timeline().messages([edit])).toMatchObject([
    {
      item: {
        type: "tool_call",
        name: "edit",
        status: "completed",
        detail: { type: "edit", filePath: "a.txt", oldString: "beta", newString: "BETA" },
      },
    },
  ]);
});

test("a surrogate pair split across deltas streams back intact", () => {
  const timeline = new V2Timeline();
  const part = { assistantMessageID: "answer", type: "text" as const, ordinal: 0 };
  timeline.startPart(part);
  const chunks = ["a\uD83D", "\uDE00b"].map((delta) => {
    const event = timeline.delta({ ...part, delta });
    return event?.type === "timeline" && event.item.type === "assistant_message"
      ? event.item.text
      : null;
  });
  expect(chunks).toEqual(["a\uD83D", "\uDE00b"]);
  expect(chunks.join("")).toBe("a😀b");
});

function retainedBytesAfterStreaming(mode: "delta" | "snapshot", chunks: number): number {
  const fixture = fileURLToPath(
    new URL("../test-utils/v2-streamed-text-memory.ts", import.meta.url),
  );
  const output = execFileSync(
    process.execPath,
    ["--expose-gc", "--import", "tsx", fixture, mode, String(chunks)],
    { encoding: "utf8" },
  );
  return Number(output);
}

test.each(["delta", "snapshot"] as const)(
  "a long %s-streamed part holds memory in proportion to its text",
  (mode) => {
    const chunks = 2000;
    const textBytes = chunks * 64;
    expect(retainedBytesAfterStreaming(mode, chunks)).toBeLessThan(textBytes * 32);
  },
);

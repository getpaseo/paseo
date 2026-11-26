import { describe, expect, it } from "vitest";
import type { ProjectedTimelineRow } from "../timeline-projection.js";
import {
  buildProviderSwitchHandoff,
  prependHandoffAttachment,
  renderProviderPromptText,
} from "./index.js";

const TS = "2026-11-25T10:00:00.000Z";

function row(
  seq: number,
  item: ProjectedTimelineRow["item"],
  provider = "claude",
): ProjectedTimelineRow {
  return {
    seq,
    seqStart: seq,
    seqEnd: seq,
    sourceSeqRanges: [[seq, seq]],
    timestamp: TS,
    provider,
    item,
    collapsed: [],
  };
}

describe("buildProviderSwitchHandoff", () => {
  it("returns a null attachment and zero summary when there is no prior active history", () => {
    const handoff = buildProviderSwitchHandoff({
      rows: [],
      hasOlder: false,
      fromProvider: "claude",
      toProvider: "codex",
      agentTitle: "Refactor auth",
      cwd: "/repo",
    });

    expect(handoff.attachment).toBeNull();
    expect(handoff.summary).toEqual({
      includedItems: 0,
      truncated: false,
      charCount: 0,
      budgetChars: 100_000,
    });
  });

  it("curates user messages, assistant messages, tool calls, and prior provider switches while omitting reasoning and errors", () => {
    const handoff = buildProviderSwitchHandoff({
      rows: [
        row(1, { type: "user_message", text: "Fix the bug", messageId: "m1" }),
        row(2, { type: "reasoning", text: "Internal chain of thought" }),
        row(3, {
          type: "tool_call",
          callId: "c1",
          name: "read_file",
          status: "completed",
          error: null,
          detail: { type: "read", filePath: "src/app.ts" },
        }),
        row(4, { type: "assistant_message", text: "I found the issue in src/app.ts." }),
        row(5, { type: "error", message: "Transient warning" }),
        row(6, {
          type: "provider_switch",
          fromProvider: "claude",
          toProvider: "opencode",
          fromModel: "sonnet",
          toModel: "gemini",
          fromSessionId: "s1",
          toSessionId: "s2",
          context: { includedItems: 2, truncated: false, charCount: 100, budgetChars: 100_000 },
        }),
      ],
      hasOlder: false,
      fromProvider: "opencode",
      toProvider: "codex",
      agentTitle: "Bug fix",
      cwd: "/repo",
    });

    expect(handoff.attachment).not.toBeNull();
    expect(handoff.attachment?.type).toBe("text");
    expect(handoff.attachment?.mimeType).toBe("text/plain");
    expect(handoff.attachment?.contextKind).toBe("chat_history");
    expect(handoff.attachment?.text).toContain("<chat-history-summary>");
    expect(handoff.attachment?.text).toContain("[User] Fix the bug");
    expect(handoff.attachment?.text).toContain("[Assistant] I found the issue in src/app.ts.");
    expect(handoff.attachment?.text).toContain("[Switched provider: claude -> opencode]");
    expect(handoff.attachment?.text).not.toContain("Internal chain of thought");
    expect(handoff.attachment?.text).not.toContain("Transient warning");
    expect(handoff.summary.includedItems).toBe(4);
    expect(handoff.summary.truncated).toBe(false);
    expect(handoff.summary.omittedReasons).toBeUndefined();
    expect(handoff.summary.charCount).toBe(handoff.attachment?.text.length);
  });

  it("marks tail_window_limit when hasOlder is true and char_budget when history exceeds budgetChars", () => {
    const bigReply = "x".repeat(500);
    const handoff = buildProviderSwitchHandoff({
      rows: [
        row(10, { type: "user_message", text: "First prompt in window", messageId: "m1" }),
        row(11, { type: "assistant_message", text: bigReply }),
        row(12, { type: "user_message", text: "Most recent prompt", messageId: "m2" }),
      ],
      hasOlder: true,
      fromProvider: "claude",
      toProvider: "codex",
      budgetChars: 350,
    });

    expect(handoff.attachment).not.toBeNull();
    expect(handoff.attachment!.text.length).toBeLessThanOrEqual(350);
    expect(handoff.attachment!.text).toContain("[Earlier chat history omitted]");
    expect(handoff.attachment!.text).toContain("[User] Most recent prompt");
    expect(handoff.summary.truncated).toBe(true);
    expect(handoff.summary.omittedReasons).toEqual(["tail_window_limit", "char_budget"]);
    expect(handoff.summary.includedItems).toBe(1);
  });

  it("caps included items to HANDOFF_TAIL_LIMIT when a single turn exceeds 80 rows", () => {
    const oversizedRows = Array.from({ length: 85 }, (_, index) =>
      row(index + 1, {
        type: "assistant_message",
        text: `Step ${index + 1}`,
      }),
    );
    const handoff = buildProviderSwitchHandoff({
      rows: oversizedRows,
      hasOlder: false,
      fromProvider: "claude",
      toProvider: "codex",
    });

    expect(handoff.attachment).not.toBeNull();
    expect(handoff.summary.includedItems).toBe(80);
    expect(handoff.summary.truncated).toBe(true);
    expect(handoff.summary.omittedReasons).toEqual(["tail_window_limit"]);
    expect(handoff.attachment!.text).toContain("[Earlier chat history omitted]");
    expect(handoff.attachment!.text).toContain("Step 85");
    expect(handoff.attachment!.text).not.toContain("Step 1\n");
  });

  it("prepends handoff attachment and renders providerPromptText including attachments", () => {
    const attachment = {
      type: "text" as const,
      mimeType: "text/plain",
      contextKind: "chat_history" as const,
      title: "Chat history",
      text: "<chat-history-summary>\n[User] hi\n</chat-history-summary>",
    };
    const combined = prependHandoffAttachment("Continue here", attachment);
    expect(Array.isArray(combined)).toBe(true);
    expect(renderProviderPromptText(combined)).toContain("<chat-history-summary>");
    expect(renderProviderPromptText(combined)).toContain("Continue here");
  });
});

import { describe, expect, test } from "vitest";

import {
  normalizeGrokToolResultText,
  normalizeGrokUserMessageText,
  transformGrokToolSnapshot,
} from "./grok-message-tags.js";

describe("normalizeGrokUserMessageText", () => {
  test("hides system-reminder-only messages", () => {
    expect(
      normalizeGrokUserMessageText("<system-reminder>\nYou are in plan mode.\n</system-reminder>"),
    ).toBeNull();
  });

  test("hides user_info + git_status bootstrap context", () => {
    expect(
      normalizeGrokUserMessageText(`<user_info>
OS Version: darwin
</user_info>
<git_status>
## main
</git_status>`),
    ).toBeNull();
  });

  test("unwraps user_query after stripping context envelopes", () => {
    expect(
      normalizeGrokUserMessageText(`<user_info>
OS Version: darwin
</user_info>
<git_status>
## main
</git_status>
<user_query>
fix the context meter
</user_query>`),
    ).toBe("fix the context meter");
  });

  test("unwraps a bare user_query wrapper", () => {
    expect(normalizeGrokUserMessageText("<user_query>\nhello\n</user_query>")).toBe("hello");
  });

  test("unwraps spoken-input and drops instruction", () => {
    expect(
      normalizeGrokUserMessageText(`<spoken-input>
open the settings
</spoken-input>
<instruction>
Transcribe accurately.
</instruction>`),
    ).toBe("open the settings");
  });

  test("unwraps spoken-input nested inside user_query", () => {
    expect(
      normalizeGrokUserMessageText(`<user_query>
<spoken-input>
Hollow, hollow.
</spoken-input>
<instruction>This message was spoken by the user. Respond using the speak tool only, not normal messages, because the user may not be looking at the chat.</instruction>
</user_query>`),
    ).toBe("Hollow, hollow.");
  });

  test("strips embedded system-reminder from a real user message", () => {
    expect(
      normalizeGrokUserMessageText(`<system-reminder>
Ignore prior tools.
</system-reminder>
<user_query>
continue
</user_query>`),
    ).toBe("continue");
  });

  test("passes through plain user text", () => {
    expect(normalizeGrokUserMessageText("plain prompt")).toBe("plain prompt");
  });
});

describe("normalizeGrokToolResultText", () => {
  test("unwraps workspace_result", () => {
    expect(
      normalizeGrokToolResultText(
        '<workspace_result workspace_path="/tmp/proj">\nhello\n</workspace_result>',
      ),
    ).toBe("hello");
  });

  test("leaves non-wrapped tool text alone", () => {
    expect(normalizeGrokToolResultText("raw tool output")).toBe("raw tool output");
  });
});

describe("transformGrokToolSnapshot", () => {
  test("unwraps workspace_result from content text blocks", () => {
    const next = transformGrokToolSnapshot({
      toolCallId: "t1",
      title: "Read",
      content: [
        {
          type: "content",
          content: {
            type: "text",
            text: "<workspace_result>\nline one\n</workspace_result>",
          },
        },
      ],
    });
    expect(next.content?.[0]).toEqual({
      type: "content",
      content: { type: "text", text: "line one" },
    });
  });

  test("unwraps workspace_result from rawOutput string fields", () => {
    const next = transformGrokToolSnapshot({
      toolCallId: "t2",
      title: "Read",
      rawOutput: {
        content: "<workspace_result>\nbody\n</workspace_result>",
      },
    });
    expect(next.rawOutput).toEqual({ content: "body" });
  });
});

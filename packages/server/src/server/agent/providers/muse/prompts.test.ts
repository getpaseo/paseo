import { describe, expect, test } from "vitest";

import { convertMusePromptInput } from "./prompts.js";

describe("convertMusePromptInput", () => {
  test("passes a string prompt through as one text part", () => {
    const payload = convertMusePromptInput("hello");

    expect(payload).toEqual({
      parts: [{ type: "text", text: "hello" }],
      displayText: "hello",
      text: "hello",
    });
  });

  test("preserves block order and maps images natively", () => {
    const payload = convertMusePromptInput([
      { type: "text", text: "look:" },
      { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
      { type: "text", text: "after" },
    ]);

    expect(payload.parts).toEqual([
      { type: "text", text: "look:" },
      { type: "image", base64Data: "aGVsbG8=", mediaType: "image/png" },
      { type: "text", text: "after" },
    ]);
    expect(payload.displayText).toBe("look:\n\nafter");
  });

  test("renders attachments as text", () => {
    const payload = convertMusePromptInput([
      { type: "text", text: "review this" },
      { type: "text", mimeType: "text/plain", text: "attached notes" },
    ]);

    expect(payload.parts).toEqual([
      { type: "text", text: "review this" },
      { type: "text", text: "attached notes" },
    ]);
  });

  test("prepends the system prefix to model parts only", () => {
    const payload = convertMusePromptInput("hello", { systemPrefix: "Be terse." });

    expect(payload.parts).toEqual([
      { type: "text", text: "Be terse." },
      { type: "text", text: "hello" },
    ]);
    expect(payload.displayText).toBe("hello");
  });
});

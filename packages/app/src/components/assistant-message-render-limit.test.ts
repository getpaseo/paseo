import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ASSISTANT_MESSAGE_RENDER_CHARACTER_LIMIT,
  capAssistantMessageForRender,
  getUtf8ByteLength,
} from "./assistant-message-render-limit";

describe("assistant message render limit", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("leaves messages at the limit unchanged", () => {
    const message = "a".repeat(ASSISTANT_MESSAGE_RENDER_CHARACTER_LIMIT);

    expect(capAssistantMessageForRender(message)).toEqual({ text: message, capped: false });
  });

  it("caps oversized messages before markdown rendering", () => {
    const message = "a".repeat(ASSISTANT_MESSAGE_RENDER_CHARACTER_LIMIT + 1);

    expect(capAssistantMessageForRender(message)).toEqual({
      text: "a".repeat(ASSISTANT_MESSAGE_RENDER_CHARACTER_LIMIT),
      capped: true,
    });
  });

  it("does not split a grapheme cluster at the boundary", () => {
    const prefix = "a".repeat(ASSISTANT_MESSAGE_RENDER_CHARACTER_LIMIT - 1);

    expect(capAssistantMessageForRender(`${prefix}étail`)).toEqual({
      text: prefix,
      capped: true,
    });
  });

  it("counts the complete message size in UTF-8 bytes", () => {
    expect(getUtf8ByteLength("aé😀")).toBe(7);
  });

  it("keeps a bounded prefix when grapheme segmentation is unavailable", async () => {
    vi.resetModules();
    vi.stubGlobal("Intl", { ...Intl, Segmenter: undefined });
    const { capAssistantMessageForRender: capWithoutSegmenter } =
      await import("./assistant-message-render-limit");
    const message = "a".repeat(ASSISTANT_MESSAGE_RENDER_CHARACTER_LIMIT + 1);

    expect(capWithoutSegmenter(message)).toEqual({
      text: "a".repeat(ASSISTANT_MESSAGE_RENDER_CHARACTER_LIMIT),
      capped: true,
    });
  });
});

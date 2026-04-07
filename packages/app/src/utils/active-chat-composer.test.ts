import { afterEach, describe, expect, it, vi } from "vitest";
import {
  __activeChatComposerTestUtils,
  insertIntoActiveChatComposer,
  markActiveChatComposer,
  registerActiveChatComposer,
} from "./active-chat-composer";
afterEach(() => {
  __activeChatComposerTestUtils.reset();
});

describe("active chat composer registry", () => {
  it("inserts into the last active composer", () => {
    const insertText = vi.fn(() => true);
    const activateTab = vi.fn();
    const dispose = registerActiveChatComposer({
      id: "server:agent",
      handle: { insertText, activateTab },
    });

    markActiveChatComposer("server:agent");

    expect(insertIntoActiveChatComposer("src/example.ts")).toBe(true);
    expect(insertText).toHaveBeenCalledWith("src/example.ts");
    expect(activateTab).toHaveBeenCalledTimes(1);

    dispose();
  });
});

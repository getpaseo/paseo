import { describe, expect, test } from "vitest";

import { resolveRewindMenuItems } from "./use-rewind-capabilities";

describe("resolveRewindMenuItems", () => {
  test("returns no items when the provider declares no rewind capability", () => {
    expect(
      resolveRewindMenuItems({
        supportsRewindConversation: false,
        supportsRewindFiles: false,
        supportsRewindBoth: false,
      }),
    ).toEqual([]);
  });

  test("returns only the capabilities declared by the provider", () => {
    expect(
      resolveRewindMenuItems({
        supportsRewindConversation: true,
        supportsRewindFiles: false,
        supportsRewindBoth: true,
      }),
    ).toEqual([
      {
        mode: "conversation",
        label: "Rewind conversation",
        testID: "rewind-menu-conversation",
      },
      {
        mode: "both",
        label: "Rewind conversation and files",
        testID: "rewind-menu-both",
      },
    ]);
  });

  test("uses caller-provided labels for available capabilities", () => {
    expect(
      resolveRewindMenuItems(
        {
          supportsRewindConversation: true,
          supportsRewindFiles: true,
          supportsRewindBoth: false,
        },
        {
          conversation: "Conversation label",
          files: "Files label",
          both: "Both label",
        },
      ).map((item) => item.label),
    ).toEqual(["Conversation label", "Files label"]);
  });
});

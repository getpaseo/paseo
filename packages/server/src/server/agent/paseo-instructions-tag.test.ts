import { describe, expect, test } from "vitest";

import {
  formatPaseoInstructionTag,
  hasLeadingPaseoInstructionTag,
  injectLeadingPaseoInstructionTag,
  stripLeadingPaseoInstructionTag,
} from "./paseo-instructions-tag.js";

describe("paseo instruction tags", () => {
  test("formatPaseoInstructionTag wraps content", () => {
    expect(formatPaseoInstructionTag("hello")).toBe(
      "<paseo-instructions>\nhello\n</paseo-instructions>"
    );
  });

  test("hasLeadingPaseoInstructionTag detects leading tag", () => {
    expect(hasLeadingPaseoInstructionTag("<paseo-instructions>\nX\n</paseo-instructions>")).toBe(
      true
    );
    expect(hasLeadingPaseoInstructionTag("nope <paseo-instructions>")).toBe(false);
  });

  test("stripLeadingPaseoInstructionTag strips leading tag content", () => {
    const input = [
      "<paseo-instructions>",
      "do the thing",
      "</paseo-instructions>",
      "",
      "Hello world",
    ].join("\n");
    expect(stripLeadingPaseoInstructionTag(input)).toBe("Hello world");
  });

  test("injectLeadingPaseoInstructionTag prepends instructions when missing", () => {
    expect(injectLeadingPaseoInstructionTag("Hello", "do the thing")).toBe(
      "<paseo-instructions>\ndo the thing\n</paseo-instructions>\n\nHello"
    );
  });

  test("injectLeadingPaseoInstructionTag is idempotent when tag already present", () => {
    const input = "<paseo-instructions>\nX\n</paseo-instructions>\n\nHello";
    expect(injectLeadingPaseoInstructionTag(input, "do the thing")).toBe(input);
  });
});

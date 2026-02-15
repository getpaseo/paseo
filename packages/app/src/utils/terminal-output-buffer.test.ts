import { describe, expect, it } from "vitest";

import {
  appendTerminalOutputBuffer,
  createTerminalOutputBuffer,
  readTerminalOutputBuffer,
} from "./terminal-output-buffer";

describe("terminal-output-buffer", () => {
  it("keeps appended text within max chars without rebuilding from scratch", () => {
    const buffer = createTerminalOutputBuffer();

    appendTerminalOutputBuffer({ buffer, text: "abc", maxChars: 5 });
    appendTerminalOutputBuffer({ buffer, text: "de", maxChars: 5 });

    expect(readTerminalOutputBuffer({ buffer })).toBe("abcde");

    appendTerminalOutputBuffer({ buffer, text: "f", maxChars: 5 });
    expect(readTerminalOutputBuffer({ buffer })).toBe("bcdef");

    appendTerminalOutputBuffer({ buffer, text: "gh", maxChars: 5 });
    expect(readTerminalOutputBuffer({ buffer })).toBe("defgh");
  });

  it("ignores empty appends and preserves current content", () => {
    const buffer = createTerminalOutputBuffer();
    appendTerminalOutputBuffer({ buffer, text: "hello", maxChars: 10 });
    appendTerminalOutputBuffer({ buffer, text: "", maxChars: 10 });

    expect(readTerminalOutputBuffer({ buffer })).toBe("hello");
  });

  it("handles large overflow by trimming entire leading segments", () => {
    const buffer = createTerminalOutputBuffer();

    appendTerminalOutputBuffer({ buffer, text: "12345", maxChars: 8 });
    appendTerminalOutputBuffer({ buffer, text: "6789", maxChars: 8 });
    appendTerminalOutputBuffer({ buffer, text: "ABCDEF", maxChars: 8 });

    expect(readTerminalOutputBuffer({ buffer })).toBe("89ABCDEF");
  });
});

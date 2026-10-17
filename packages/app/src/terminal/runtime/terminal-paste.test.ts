import { describe, expect, it } from "vitest";

import { encodeTerminalPaste, pasteTerminalClipboard } from "./terminal-paste";

describe("terminal paste encoding", () => {
  it("normalizes pasted newlines when bracketed paste mode is off", () => {
    expect(encodeTerminalPaste({ text: "echo hello\n", bracketedPaste: false })).toEqual(
      "echo hello\r",
    );
  });

  it("wraps pasted text when bracketed paste mode is on", () => {
    expect(encodeTerminalPaste({ text: "echo hello\n", bracketedPaste: true })).toEqual(
      "\x1b[200~echo hello\r\x1b[201~",
    );
  });

  it("neutralizes embedded bracketed paste end markers before wrapping", () => {
    expect(
      encodeTerminalPaste({
        text: "echo safe\x1b[201~echo unsafe\n",
        bracketedPaste: true,
      }),
    ).toEqual("\x1b[200~echo safe[201~echo unsafe\r\x1b[201~");
  });

  it.each([false, true])(
    "normalizes LF and CRLF, preserving CR (bracketed=%s)",
    (bracketedPaste) => {
      const result = encodeTerminalPaste({ text: "one\ntwo\r\nthree\rfour", bracketedPaste });
      expect(result).toBe(
        bracketedPaste ? "\x1b[200~one\rtwo\rthree\rfour\x1b[201~" : "one\rtwo\rthree\rfour",
      );
    },
  );

  it("reads clipboard through the explicit paste adapter", async () => {
    const pasted: string[] = [];

    await pasteTerminalClipboard({
      clipboard: { readText: async () => "printf one\nprintf two" },
      terminal: { paste: (text) => pasted.push(text) },
    });

    expect(pasted).toEqual(["printf one\nprintf two"]);
  });

  it("does not dispatch terminal input when clipboard is empty", async () => {
    const pasted: string[] = [];

    await pasteTerminalClipboard({
      clipboard: { readText: async () => "" },
      terminal: { paste: (text) => pasted.push(text) },
    });

    expect(pasted).toEqual([]);
  });
});

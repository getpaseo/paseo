import { describe, expect, it } from "vitest";
import {
  isPaperclipIssueUrl,
  paperclipIssueUrl,
  paperclipKeyOfCode,
  resolvePaperclipWebBase,
  rewritePaperclipHref,
  splitPaperclipKeys,
} from "./links";

const CONFIG = { webBaseUrl: "http://100.76.77.158:3110", prefixes: ["VIZ", "VIZA"] };

describe("Paperclip links", () => {
  it("finds the board's own keys and leaves look-alikes alone", () => {
    expect(
      splitPaperclipKeys("Siehe VIZ-70 und VIZA-4, nicht DCAI-2097 oder xVIZ-1.", CONFIG.prefixes),
    ).toEqual([
      { kind: "text", text: "Siehe " },
      { kind: "issue", key: "VIZ-70" },
      { kind: "text", text: " und " },
      { kind: "issue", key: "VIZA-4" },
      { kind: "text", text: ", nicht DCAI-2097 oder xVIZ-1." },
    ]);
    expect(splitPaperclipKeys("VIZ-70", [])).toEqual([{ kind: "text", text: "VIZ-70" }]);
  });

  it("links a code span that is exactly one key", () => {
    expect(paperclipKeyOfCode("VIZ-70", CONFIG.prefixes)).toBe("VIZ-70");
    expect(paperclipKeyOfCode("VIZ-70 done", CONFIG.prefixes)).toBeNull();
  });

  it("builds the issue address and rewrites loopback links agents write", () => {
    expect(paperclipIssueUrl(CONFIG, "VIZA-4")).toBe(
      "http://100.76.77.158:3110/VIZA/issues/VIZA-4",
    );
    expect(rewritePaperclipHref("/VIZ/issues/VIZ-61", CONFIG)).toBe(
      "http://100.76.77.158:3110/VIZ/issues/VIZ-61",
    );
    expect(rewritePaperclipHref("http://localhost:3110/VIZ/issues/VIZ-61#comments", CONFIG)).toBe(
      "http://100.76.77.158:3110/VIZ/issues/VIZ-61",
    );
    expect(rewritePaperclipHref("https://github.com/VIZ/issues/VIZ-61", CONFIG)).toBeNull();
    expect(isPaperclipIssueUrl("http://100.76.77.158:3110/VIZ/issues/VIZ-61", CONFIG)).toBe(true);
  });

  it("swaps a loopback board address for the host the app reaches", () => {
    expect(resolvePaperclipWebBase("http://127.0.0.1:3110", "100.76.77.158:6767")).toBe(
      "http://100.76.77.158:3110",
    );
    expect(resolvePaperclipWebBase("http://127.0.0.1:3110", "127.0.0.1:6767")).toBe(
      "http://127.0.0.1:3110",
    );
    expect(resolvePaperclipWebBase("https://paperclip.example", "100.76.77.158:6767")).toBe(
      "https://paperclip.example",
    );
  });
});

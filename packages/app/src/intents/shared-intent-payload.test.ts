import { describe, expect, it } from "vitest";
import { buildSharedPromptText, parseSharedIntentPayload } from "./shared-intent-payload";

describe("parseSharedIntentPayload", () => {
  it("accepts a text share and defaults the file list", () => {
    expect(parseSharedIntentPayload({ kind: "share", text: "hello" })).toEqual({
      kind: "share",
      text: "hello",
      files: [],
      skippedFiles: 0,
    });
  });

  it("rejects payloads with an unknown kind or malformed files", () => {
    expect(parseSharedIntentPayload({ kind: "open", text: "x" })).toBeNull();
    expect(
      parseSharedIntentPayload({ kind: "share", files: [{ uri: "", mimeType: "image/png" }] }),
    ).toBeNull();
    expect(parseSharedIntentPayload(null)).toBeNull();
  });
});

describe("buildSharedPromptText", () => {
  it("prefixes the subject when the shared text does not already contain it", () => {
    expect(
      buildSharedPromptText({
        kind: "share",
        subject: "Flaky test on main",
        text: "https://github.com/getpaseo/paseo/issues/1",
        files: [],
        skippedFiles: 0,
      }),
    ).toBe("Flaky test on main\nhttps://github.com/getpaseo/paseo/issues/1");
  });

  it("drops a subject the browser repeated inside the text", () => {
    expect(
      buildSharedPromptText({
        kind: "share",
        subject: "Paseo",
        text: "Paseo — https://paseo.sh",
        files: [],
        skippedFiles: 0,
      }),
    ).toBe("Paseo — https://paseo.sh");
  });

  it("normalizes line endings and trims selected text", () => {
    expect(buildSharedPromptText({ kind: "process_text", text: "  a\r\nb \n" })).toBe("a\nb");
  });
});

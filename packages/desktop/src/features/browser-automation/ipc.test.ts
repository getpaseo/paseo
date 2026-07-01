import { describe, expect, it } from "vitest";

import { sanitizeDownloadFileName } from "./ipc.js";

describe("browser automation IPC", () => {
  it("strips directories from agent-supplied download filenames", () => {
    expect(
      sanitizeDownloadFileName({
        url: "https://example.com/fallback.txt",
        fileName: "../../.ssh/authorized_keys",
      }),
    ).toBe("authorized_keys");
  });

  it("falls back to a safe filename when the URL has no basename", () => {
    expect(sanitizeDownloadFileName({ url: "https://example.com/" })).toBe("download");
  });
});

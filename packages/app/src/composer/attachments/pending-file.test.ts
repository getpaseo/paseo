import { describe, expect, it } from "vitest";
import { i18n } from "@/i18n/i18next";
import { pendingFilePillLabel } from "./pending-file";

function pastedTextFile(fileName = "pasted-text-1.txt") {
  return {
    fileName,
    mimeType: "text/plain",
    readBytes: async () => new Uint8Array(),
  };
}

describe("pending file pill label", () => {
  it("points a failed upload at retry and removal instead of repeating the daemon error", () => {
    expect(
      pendingFilePillLabel(
        { id: 1, file: pastedTextFile(), failed: true },
        i18n.t("composer.attachments.fileUploadFailed"),
      ),
    ).toEqual({
      title: "pasted-text-1.txt",
      subtitle: "Upload failed. Retry or remove.",
    });
  });

  it("names the file type while the upload is in flight", () => {
    expect(
      pendingFilePillLabel(
        { id: 2, file: pastedTextFile(), failed: false },
        i18n.t("composer.attachments.fileUploadFailed"),
      ),
    ).toEqual({ title: "pasted-text-1.txt", subtitle: "TXT" });
  });
});

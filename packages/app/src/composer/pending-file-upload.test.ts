import { describe, expect, it } from "vitest";
import { createPendingFileUpload } from "./pending-file-upload";

const file = {
  fileName: "movie.mp4",
  mimeType: "video/mp4",
  readBytes: async () => new Uint8Array(),
};

describe("pending file upload", () => {
  it("has no progress until the daemon reports", () => {
    expect(createPendingFileUpload(1, file).getProgress()).toBeNull();
  });

  it("notifies its pill only when the whole percent changes", () => {
    const upload = createPendingFileUpload(1, file);
    let renders = 0;
    upload.subscribe(() => {
      renders++;
    });

    upload.reportProgress({ receivedBytes: 0, totalBytes: 1000 });
    upload.reportProgress({ receivedBytes: 4, totalBytes: 1000 });
    upload.reportProgress({ receivedBytes: 9, totalBytes: 1000 });
    expect(renders).toBe(1);
    expect(upload.getProgress()).toBe(0);

    upload.reportProgress({ receivedBytes: 420, totalBytes: 1000 });
    expect(renders).toBe(2);
    expect(upload.getProgress()).toBe(0.42);

    upload.reportProgress({ receivedBytes: 1000, totalBytes: 1000 });
    expect(upload.getProgress()).toBe(1);
  });

  it("reports an empty file as complete", () => {
    const upload = createPendingFileUpload(1, file);
    upload.reportProgress({ receivedBytes: 0, totalBytes: 0 });
    expect(upload.getProgress()).toBe(1);
  });

  it("stops notifying an unsubscribed pill", () => {
    const upload = createPendingFileUpload(1, file);
    let renders = 0;
    const unsubscribe = upload.subscribe(() => {
      renders++;
    });
    unsubscribe();
    upload.reportProgress({ receivedBytes: 1, totalBytes: 2 });
    expect(renders).toBe(0);
  });
});

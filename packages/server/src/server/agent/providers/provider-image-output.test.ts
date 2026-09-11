import { existsSync, mkdtempSync, readdirSync, rmSync, utimesSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  __resetMaterializedImageAttachmentDirForTests,
  isProviderImageMarkdown,
  materializeProviderImage,
  renderProviderImageOutputAsAssistantMarkdown,
} from "./provider-image-output.js";

const HASH = "a".repeat(64);

// Materialized images live under the paseo home now, so without this every test
// run would read and delete the developer's real provider images.
const originalPaseoHome = process.env.PASEO_HOME;
let testHome: string | null = null;

function useTempPaseoHome(): string {
  testHome = mkdtempSync(path.join(os.tmpdir(), "paseo-provider-images-"));
  process.env.PASEO_HOME = testHome;
  __resetMaterializedImageAttachmentDirForTests();
  return testHome;
}

function attachmentsDir(): string {
  if (!testHome) {
    throw new Error("useTempPaseoHome() must run before reading the attachments dir.");
  }
  return path.join(testHome, "paseo-attachments");
}

function renderImageMarkdown(imagePath: string): string {
  const item = renderProviderImageOutputAsAssistantMarkdown({ path: imagePath });
  if (!item || item.type !== "assistant_message") {
    throw new Error("Expected provider image output to render as assistant markdown.");
  }
  return item.text;
}

describe("isProviderImageMarkdown", () => {
  test("matches the markdown emitted for a materialized attachment", () => {
    expect(isProviderImageMarkdown(`![Image](/tmp/paseo-attachments/${HASH}.png)`)).toBe(true);
    expect(isProviderImageMarkdown(`![Image](/tmp/paseo-attachments-a1B2c3/${HASH}.png)`)).toBe(
      true,
    );
    expect(isProviderImageMarkdown(`![Image](/tmp/paseo-attachments/user-1000/${HASH}.png)`)).toBe(
      true,
    );
    expect(isProviderImageMarkdown(`![shot](/var/folders/x/paseo-attachments/${HASH}.webp)`)).toBe(
      true,
    );
    // Windows: backslash path separators are doubled by escapeMarkdownImageSource.
    expect(
      isProviderImageMarkdown(
        `![Image](C:\\\\Users\\\\me\\\\AppData\\\\Local\\\\Temp\\\\paseo-attachments\\\\${HASH}.png)`,
      ),
    ).toBe(true);
  });

  test("emits Windows file paths as file URIs", () => {
    const markdown = renderImageMarkdown(
      `C:\\Users\\me\\AppData\\Local\\Temp\\paseo-attachments\\${HASH}.png`,
    );

    expect(markdown).toBe(
      `![Image](file:///C:/Users/me/AppData/Local/Temp/paseo-attachments/${HASH}.png)`,
    );
    expect(isProviderImageMarkdown(markdown)).toBe(true);
  });

  test("emits POSIX file paths with spaces as valid file URI markdown", () => {
    const markdown = renderImageMarkdown("/home/user/Projects/Project With Spaces/screenshot.png");

    expect(markdown).toBe(
      "![Image](file:///home/user/Projects/Project%20With%20Spaces/screenshot.png)",
    );
  });

  test("encodes URI-significant characters in POSIX file paths", () => {
    const markdown = renderImageMarkdown("/tmp/screenshot#1?draft.png");

    expect(markdown).toBe("![Image](file:///tmp/screenshot%231%3Fdraft.png)");
  });

  test("preserves double-leading slashes in POSIX file paths", () => {
    const markdown = renderImageMarkdown("//tmp/screenshot#1.png");

    expect(markdown).toBe("![Image](file:////tmp/screenshot%231.png)");
  });

  test.each([
    ["UNC", "\\\\server\\share\\shot#1.png", "file://server/share/shot%231.png"],
    [
      "extended UNC",
      "\\\\?\\UNC\\server\\share\\shot?draft.png",
      "file://server/share/shot%3Fdraft.png",
    ],
  ])("encodes %s image paths as file URIs", (_label, imagePath, expectedSource) => {
    expect(renderImageMarkdown(imagePath)).toBe(`![Image](${expectedSource})`);
  });

  test("rejects user-authored markdown that is not a materialized attachment", () => {
    // No content hash — a hand-written path, not something the writer produced.
    expect(isProviderImageMarkdown("![diagram](./paseo-attachments/notes.png)")).toBe(false);
    expect(isProviderImageMarkdown("![logo](https://example.com/logo.png)")).toBe(false);
    // Image markdown that does not start the text.
    expect(isProviderImageMarkdown("see the chart: ![chart](x.png)")).toBe(false);
  });
});

describe("materializeProviderImage", () => {
  beforeEach(() => {
    useTempPaseoHome();
  });

  afterEach(() => {
    if (originalPaseoHome === undefined) {
      delete process.env.PASEO_HOME;
    } else {
      process.env.PASEO_HOME = originalPaseoHome;
    }
    if (testHome) {
      rmSync(testHome, { recursive: true, force: true });
      testHome = null;
    }
    __resetMaterializedImageAttachmentDirForTests();
  });

  test("recreates the private directory if the cached directory is removed", () => {
    const first = materializeProviderImage({
      data: "YWJjMTIz",
      mimeType: "image/png",
    });
    expect(existsSync(first.path)).toBe(true);

    rmSync(path.dirname(first.path), { recursive: true, force: true });

    const second = materializeProviderImage({
      data: "ZGVmNDU2",
      mimeType: "image/png",
    });

    expect(existsSync(second.path)).toBe(true);
  });

  test("stores images in a stable directory under the paseo home", () => {
    const result = materializeProviderImage({ data: "YWJjMTIz", mimeType: "image/png" });

    // A fixed directory, not a per-process mkdtemp one — the old shape is what
    // let the OS reap these images out from under the app after ~3 days.
    expect(path.dirname(result.path)).toBe(attachmentsDir());
    expect(path.basename(path.dirname(result.path))).toBe("paseo-attachments");
    // Mode assertions live in the .posix suite: Windows ignores mkdir/writeFile
    // modes and reports 0o666, so asserting them here fails on that runner.
  });

  test("is idempotent for the same bytes across daemon restarts", () => {
    const first = materializeProviderImage({ data: "YWJjMTIz", mimeType: "image/png" });

    // A fresh daemon process: module state is cleared but the directory persists.
    __resetMaterializedImageAttachmentDirForTests();
    const second = materializeProviderImage({ data: "YWJjMTIz", mimeType: "image/png" });

    expect(second.path).toBe(first.path);
    expect(readdirSync(attachmentsDir())).toHaveLength(1);
  });

  test("emits markdown that isProviderImageMarkdown still recognizes", () => {
    const item = renderProviderImageOutputAsAssistantMarkdown(
      { data: "YWJjMTIz", mimeType: "image/png" },
      { materialize: materializeProviderImage },
    );

    if (!item || item.type !== "assistant_message") {
      throw new Error("Expected provider image output to render as assistant markdown.");
    }
    expect(isProviderImageMarkdown(item.text)).toBe(true);
  });

  // The whole point of moving out of the temp dir is that nothing deletes these
  // behind the user's back. An age-based sweep would reintroduce that on a
  // longer fuse, because mtime cannot tell a referenced image from an abandoned
  // one and reading a transcript never touches the file.
  test("keeps images no matter how old they are", () => {
    const image = materializeProviderImage({ data: "YWJjMTIz", mimeType: "image/png" });
    const longAgoSeconds = Date.now() / 1000 - 365 * 24 * 60 * 60;
    utimesSync(image.path, longAgoSeconds, longAgoSeconds);

    // A fresh daemon process materializing an unrelated image: the oldest point
    // at which a startup sweep would run.
    __resetMaterializedImageAttachmentDirForTests();
    materializeProviderImage({ data: "Z2hpNzg5", mimeType: "image/png" });

    expect(existsSync(image.path)).toBe(true);
  });
});

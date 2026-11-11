import { describe, expect, it } from "vitest";
import { handleClipboardPaste, LARGE_PASTE_THRESHOLD } from "./clipboard-paste";
import type { SelectedFile } from "@/attachments/selected-file";

function paste(text: string, options: { withImage?: boolean; showAttachments?: boolean } = {}) {
  const { withImage = false, showAttachments = true } = options;
  const clipboardData = new DataTransfer();
  clipboardData.setData("text/plain", text);
  if (withImage) clipboardData.items.add(new File(["image"], "clip.png", { type: "image/png" }));
  const event = new ClipboardEvent("paste", { clipboardData, cancelable: true });
  const files: SelectedFile[] = [];
  const images: File[] = [];
  const inserted: string[] = [];
  handleClipboardPaste({
    event,
    showAttachments,
    attachText: (file) => files.push(file),
    attachImages: (items) => images.push(...items.map((item) => item.file)),
    insertText: (value) => inserted.push(value),
  });
  return { event, files, images, inserted };
}

describe("composer clipboard paste", () => {
  it("intercepts long text before the input and preserves exact UTF-8 bytes", async () => {
    const text = "中文🙂\r\n  ".repeat(1250);
    const result = paste(text);
    expect(result.event.defaultPrevented).toBe(true);
    expect(result.inserted).toEqual([]);
    expect(result.files).toHaveLength(1);
    expect(result.files[0].fileName).toMatch(/^pasted-text-\d+\.txt$/);
    expect(result.files[0].mimeType).toBe("text/plain");
    expect(new TextDecoder().decode(await result.files[0].readBytes())).toBe(text);
    expect(await result.files[0].readBytes()).toEqual(await result.files[0].readBytes());
  });

  it.each([4999, 5000, 5001])(
    "uses the Codex plain-text boundary at %i UTF-16 units",
    async (length) => {
      // Emoji count as two UTF-16 units, as they do in JS, NSString and Kotlin strings.
      const text = "🙂".repeat(Math.floor(length / 2)) + (length % 2 ? "a" : "");
      const result = paste(text);
      expect(text.length).toBe(length);
      expect(result.event.defaultPrevented).toBe(length >= 5000);
      expect(result.files).toHaveLength(length >= 5000 ? 1 : 0);
      expect(await Promise.all(result.files.map((file) => file.readBytes()))).toEqual(
        length >= 5000 ? [new TextEncoder().encode(text)] : [],
      );
      expect(result.inserted).toEqual([]);
    },
  );

  it("keeps short text on the browser's normal selection and undo path", () => {
    const result = paste("a".repeat(LARGE_PASTE_THRESHOLD - 1));
    expect(result.event.defaultPrevented).toBe(false);
    expect(result.files).toEqual([]);
    expect(result.inserted).toEqual([]);
  });

  it("attaches text at the threshold without dropping a copied image", () => {
    const result = paste("a".repeat(LARGE_PASTE_THRESHOLD), { withImage: true });
    expect(result.event.defaultPrevented).toBe(true);
    expect(result.files).toHaveLength(1);
    expect(result.images.map((file) => file.name)).toEqual(["clip.png"]);
    expect(result.inserted).toEqual([]);
  });

  it("inserts short mixed text once and attaches its image", () => {
    const result = paste("caption", { withImage: true });
    expect(result.event.defaultPrevented).toBe(true);
    expect(result.files).toEqual([]);
    expect(result.inserted).toEqual(["caption"]);
    expect(result.images.map((file) => file.name)).toEqual(["clip.png"]);
  });

  it("preserves image-only paste", () => {
    const result = paste("", { withImage: true });
    expect(result.event.defaultPrevented).toBe(true);
    expect(result.files).toEqual([]);
    expect(result.inserted).toEqual([]);
    expect(result.images.map((file) => file.name)).toEqual(["clip.png"]);
  });

  it("leaves a large terminal prompt with the browser instead of uploading it", () => {
    const result = paste("a".repeat(LARGE_PASTE_THRESHOLD), { showAttachments: false });
    expect(result.event.defaultPrevented).toBe(false);
    expect(result.files).toEqual([]);
    expect(result.inserted).toEqual([]);
  });

  it("leaves a terminal paste with an image with the browser", () => {
    const result = paste("caption", { withImage: true, showAttachments: false });
    expect(result.event.defaultPrevented).toBe(false);
    expect(result.files).toEqual([]);
    expect(result.images).toEqual([]);
    expect(result.inserted).toEqual([]);
  });
});

import { describe, test, expect } from "vitest";
import { extractToolResultParts } from "./tool-result-content.js";

describe("extractToolResultParts", () => {
  test("returns empty parts for undefined content", () => {
    expect(extractToolResultParts(undefined)).toEqual({ text: "", images: [] });
  });

  test("returns the string as text when content is a plain string", () => {
    expect(extractToolResultParts("hello")).toEqual({ text: "hello", images: [] });
  });

  test("concatenates text blocks in order", () => {
    const content = [
      { type: "text", text: "first " },
      { type: "text", text: "second" },
    ];
    expect(extractToolResultParts(content)).toEqual({ text: "first second", images: [] });
  });

  test("extracts a base64 image block into the images array", () => {
    const content = [
      {
        type: "image",
        source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" },
      },
    ];
    expect(extractToolResultParts(content)).toEqual({
      text: "",
      images: [{ data: "iVBORw0KGgo=", mimeType: "image/png" }],
    });
  });

  test("handles a mixed text + image array preserving order of text", () => {
    const content = [
      { type: "text", text: "before" },
      {
        type: "image",
        source: { type: "base64", media_type: "image/jpeg", data: "AAAA" },
      },
      { type: "text", text: "after" },
    ];
    expect(extractToolResultParts(content)).toEqual({
      text: "beforeafter",
      images: [{ data: "AAAA", mimeType: "image/jpeg" }],
    });
  });

  test("serializes unsupported image mime types to text fallback instead of dropping", () => {
    const content = [
      {
        type: "image",
        source: { type: "base64", media_type: "image/heic", data: "AAAA" },
      },
    ];
    const result = extractToolResultParts(content);
    expect(result.images).toEqual([]);
    expect(result.text).toContain("image/heic");
  });

  test("does not classify empty-data image blocks as images and surfaces them as text", () => {
    const content = [
      {
        type: "image",
        source: { type: "base64", media_type: "image/png", data: "" },
      },
    ];
    const result = extractToolResultParts(content);
    expect(result.images).toEqual([]);
    // Empty-data blocks fall through to the unknown-block JSON fallback so the
    // payload is preserved rather than silently dropped.
    expect(result.text).toContain('"data":""');
  });

  test("serializes URL-source image blocks to text fallback", () => {
    const content = [
      {
        type: "image",
        source: { type: "url", url: "https://example.com/x.png" },
      },
    ];
    const result = extractToolResultParts(content);
    expect(result.images).toEqual([]);
    expect(result.text).toContain("https://example.com/x.png");
  });

  test("preserves unknown block types alongside extracted text and images", () => {
    const content = [
      { type: "text", text: "before" },
      {
        type: "image",
        source: { type: "base64", media_type: "image/png", data: "AAAA" },
      },
      { type: "document", source: { type: "base64", data: "DOC" } },
    ];
    const result = extractToolResultParts(content);
    expect(result.images).toEqual([{ data: "AAAA", mimeType: "image/png" }]);
    expect(result.text).toContain("before");
    expect(result.text).toContain('"type":"document"');
  });

  test("falls back to deterministic sorted-key JSON for non-array, non-string content", () => {
    const content = { z: 3, nested: { b: 2, a: 1 }, a: 0 };
    expect(extractToolResultParts(content)).toEqual({
      text: '{"a":0,"nested":{"a":1,"b":2},"z":3}',
      images: [],
    });
  });

  test("handles circular references in the fallback path", () => {
    const obj: Record<string, unknown> = { name: "root" };
    obj.self = obj;
    const result = extractToolResultParts(obj);
    expect(result.text).toContain("[circular]");
    expect(result.images).toEqual([]);
  });
});

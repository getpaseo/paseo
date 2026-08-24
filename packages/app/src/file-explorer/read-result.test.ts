import type { FileReadResult } from "@getpaseo/client/internal/daemon-client";
import { describe, expect, it } from "vitest";
import { explorerFileFromReadResult } from "./read-result";

function textRead(bytes: Uint8Array): FileReadResult {
  return {
    bytes,
    mime: "text/plain",
    size: bytes.byteLength,
    path: "notes.txt",
    kind: "text",
    modifiedAt: "2026-07-21T00:00:00.000Z",
  };
}

describe("explorerFileFromReadResult", () => {
  it("records and hides a leading UTF-8 BOM", () => {
    const file = explorerFileFromReadResult(
      textRead(new Uint8Array([0xef, 0xbb, 0xbf, 0x68, 0x69])),
    );

    expect(file).toMatchObject({ content: "hi", hasBom: true });
  });

  it("does not mark BOM-free text or non-leading U+FEFF as BOM files", () => {
    const plain = explorerFileFromReadResult(textRead(new TextEncoder().encode("hi")));
    const embedded = explorerFileFromReadResult(
      textRead(new Uint8Array([0x68, 0x69, 0xef, 0xbb, 0xbf])),
    );

    expect(plain.hasBom).toBe(false);
    expect(embedded.hasBom).toBe(false);
  });
});

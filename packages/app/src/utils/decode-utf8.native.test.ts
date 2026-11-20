import { describe, expect, it } from "vitest";
import { decodeUtf8 } from "./decode-utf8.native";

function decodesLikeTextDecoder(bytes: Uint8Array) {
  expect(decodeUtf8(bytes)).toBe(new TextDecoder().decode(bytes));
}

describe("decodeUtf8 on native", () => {
  it("decodes ASCII, multibyte characters and emoji across chunk boundaries", () => {
    const text = "const café = '中文 🙂 %20 100%';\n".repeat(4000);
    decodesLikeTextDecoder(new TextEncoder().encode(text));
    expect(decodeUtf8(new TextEncoder().encode(text))).toBe(text);
  });

  it("drops a leading byte order mark", () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, 0x68, 0x69]);
    expect(decodeUtf8(bytes)).toBe("hi");
  });

  it("replaces malformed sequences", () => {
    decodesLikeTextDecoder(new Uint8Array([0x61, 0xff, 0x62, 0xe4, 0xb8]));
  });

  it("decodes an empty file", () => {
    expect(decodeUtf8(new Uint8Array())).toBe("");
  });
});

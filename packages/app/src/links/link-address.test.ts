import { describe, expect, it } from "vitest";
import { formatLinkAddress } from "./link-address";

describe("formatLinkAddress", () => {
  it("drops the scheme and keeps path, query, and fragment", () => {
    expect(formatLinkAddress("https://www.example.com/docs/a?b=1#c")).toBe(
      "www.example.com/docs/a?b=1#c",
    );
  });

  it("keeps the port with the host", () => {
    expect(formatLinkAddress("http://127.0.0.1:8795/chat-link")).toBe("127.0.0.1:8795/chat-link");
  });

  it("drops the bare root path", () => {
    expect(formatLinkAddress("https://www.google.com")).toBe("www.google.com");
  });

  it("returns an unparseable link whole", () => {
    expect(formatLinkAddress("not a url")).toBe("not a url");
  });
});

import { describe, expect, it } from "vitest";
import { isMermaidFence } from "./mermaid-fence";

describe("isMermaidFence", () => {
  it("matches a bare mermaid fence", () => {
    expect(isMermaidFence("mermaid")).toBe(true);
  });

  it("matches case-insensitively", () => {
    expect(isMermaidFence("Mermaid")).toBe(true);
  });

  it("matches when trailing fence metadata follows", () => {
    expect(isMermaidFence("mermaid {theme: dark}")).toBe(true);
  });

  it("rejects other languages", () => {
    expect(isMermaidFence("ts")).toBe(false);
    expect(isMermaidFence("markdown")).toBe(false);
  });

  it("rejects null, undefined, and empty info strings", () => {
    expect(isMermaidFence(null)).toBe(false);
    expect(isMermaidFence(undefined)).toBe(false);
    expect(isMermaidFence("")).toBe(false);
    expect(isMermaidFence("   ")).toBe(false);
  });
});

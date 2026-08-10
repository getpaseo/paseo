import { describe, expect, it } from "vitest";
import { mermaidRuntimeHtml } from "./html.gen";

describe("Mermaid runtime document", () => {
  it("ships a closed network policy", () => {
    expect(mermaidRuntimeHtml).toContain("default-src 'none'");
    expect(mermaidRuntimeHtml).toContain("connect-src 'none'");
    expect(mermaidRuntimeHtml).toContain("img-src data: blob:");
    expect(mermaidRuntimeHtml).toContain("font-src 'none'");
    expect(mermaidRuntimeHtml).toContain("frame-src 'none'");
  });
});

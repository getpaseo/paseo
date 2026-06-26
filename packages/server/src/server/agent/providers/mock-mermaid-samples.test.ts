import { describe, expect, it } from "vitest";
import {
  MOCK_MERMAID_DIAGRAM_IDS,
  buildMermaidFence,
  buildMermaidMarkdownGallery,
} from "./mock-mermaid-samples.js";

describe("mock-mermaid-samples", () => {
  it("includes every supported diagram id in the gallery", () => {
    const gallery = buildMermaidMarkdownGallery();
    for (const id of MOCK_MERMAID_DIAGRAM_IDS) {
      expect(gallery).toContain("```mermaid");
      expect(buildMermaidFence(id)).toMatch(/^```mermaid\n[\s\S]+\n```$/);
    }
    expect(gallery.match(/```mermaid/g)?.length).toBe(MOCK_MERMAID_DIAGRAM_IDS.length);
  });
});

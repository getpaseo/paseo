import { describe, expect, it } from "vitest";
import { containsUnsafeMermaidSource, isMermaidFence } from "./mermaid-fence";

describe("isMermaidFence", () => {
  it("matches the mermaid fence language", () => {
    expect(isMermaidFence("mermaid")).toBe(true);
    expect(isMermaidFence("Mermaid")).toBe(true);
    expect(isMermaidFence("mermaid {init: {}}")).toBe(true);
    expect(isMermaidFence("  mermaid  ")).toBe(true);
  });

  it("rejects everything else", () => {
    expect(isMermaidFence("mermaidjs")).toBe(false);
    expect(isMermaidFence("ts")).toBe(false);
    expect(isMermaidFence("")).toBe(false);
    expect(isMermaidFence(null)).toBe(false);
    expect(isMermaidFence(undefined)).toBe(false);
  });
});

describe("containsUnsafeMermaidSource", () => {
  it("rejects resource-bearing constructs", () => {
    expect(containsUnsafeMermaidSource('flowchart TD\n  A@{ img: "https://x/y.png" }')).toBe(true);
    expect(containsUnsafeMermaidSource("flowchart TD\n  A@{ icon: 'pack:name' }")).toBe(true);
    expect(
      containsUnsafeMermaidSource('%%{init: {"themeCSS": "a { color: red }"}}%%\ngraph TD'),
    ).toBe(true);
    expect(containsUnsafeMermaidSource("graph TD\n A[url(http://x)]")).toBe(true);
    expect(containsUnsafeMermaidSource("graph TD\n A[@import 'x']")).toBe(true);
    expect(containsUnsafeMermaidSource('graph TD\n A["<img src=x>"]')).toBe(true);
    expect(containsUnsafeMermaidSource('graph TD\n A["&#60;img src=x&#62;"]')).toBe(true);
    expect(containsUnsafeMermaidSource('graph TD\n A["</b>"]')).toBe(true);
  });

  it("rejects quoted and escaped key evasions", () => {
    expect(containsUnsafeMermaidSource('flowchart TD\n  A@{ "img": "https://x/y.png" }')).toBe(
      true,
    );
    expect(containsUnsafeMermaidSource("flowchart TD\n  A@{ 'img': 'https://x/y.png' }")).toBe(
      true,
    );
    expect(
      containsUnsafeMermaidSource('flowchart TD\n  A@{ "\\u0069mg": "https://x/y.png" }'),
    ).toBe(true);
    expect(
      containsUnsafeMermaidSource('flowchart TD\n  A@{ "\\u{69}mg": "https://x/y.png" }'),
    ).toBe(true);
    expect(containsUnsafeMermaidSource('flowchart TD\n  A@{ "\\x69mg": "https://x/y.png" }')).toBe(
      true,
    );
    expect(containsUnsafeMermaidSource('flowchart TD\n  A@{ "icon": "pack:name" }')).toBe(true);
  });

  it("allows ordinary diagrams including <br> labels", () => {
    expect(containsUnsafeMermaidSource("flowchart TD\n  A[Start] --> B{Choice}")).toBe(false);
    expect(containsUnsafeMermaidSource('graph TD\n A["line one<br>line two"]')).toBe(false);
    expect(containsUnsafeMermaidSource('graph TD\n A["line one<br/>line two"]')).toBe(false);
    expect(containsUnsafeMermaidSource("sequenceDiagram\n  Alice->>Bob: a < b and x > y")).toBe(
      false,
    );
  });
});

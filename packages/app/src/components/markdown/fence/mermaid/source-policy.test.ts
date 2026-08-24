import { describe, expect, it } from "vitest";
import { containsUnsafeMermaidSource } from "./source-policy";

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
    expect(containsUnsafeMermaidSource('graph TD\n A["<i class=x>styled</i>"]')).toBe(true);
    expect(containsUnsafeMermaidSource('graph TD\n A["&#60;img src=x&#62;"]')).toBe(true);
    expect(containsUnsafeMermaidSource('graph TD\n A["</b>"]')).toBe(true);
  });

  it("rejects all shape-data constructs, including yaml key evasions", () => {
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
    expect(
      containsUnsafeMermaidSource('flowchart TD\n  A@{ "\\U00000069mg": "https://attacker/x" }'),
    ).toBe(true);
    expect(containsUnsafeMermaidSource('flowchart TD\n  A@{ "icon": "pack:name" }')).toBe(true);
    expect(
      containsUnsafeMermaidSource(
        'flowchart TD\n  A@{ ? img # comment\n  : "https://attacker/x" }',
      ),
    ).toBe(true);
    expect(
      containsUnsafeMermaidSource(
        'flowchart TD\n  A@{ dummy: &k img\n  ? *k # comment\n  : "https://attacker/x" }',
      ),
    ).toBe(true);
  });

  it("fails closed for malformed or out-of-range escapes without throwing", () => {
    expect(() =>
      containsUnsafeMermaidSource('graph TD\n A["\\u{110000} disguised"]'),
    ).not.toThrow();
    expect(containsUnsafeMermaidSource('graph TD\n A["\\u{110000} disguised"]')).toBe(true);
    expect(() =>
      containsUnsafeMermaidSource('graph TD\n A["\\u{FFFFFF} disguised"]'),
    ).not.toThrow();
    expect(containsUnsafeMermaidSource('graph TD\n A["\\u{FFFFFF} disguised"]')).toBe(true);
  });

  it("allows ordinary diagrams including formatting-only labels", () => {
    expect(containsUnsafeMermaidSource("flowchart TD\n  A[Start] --> B{Choice}")).toBe(false);
    expect(containsUnsafeMermaidSource('graph TD\n A["line one<br>line two"]')).toBe(false);
    expect(containsUnsafeMermaidSource('graph TD\n A["line one<br/>line two"]')).toBe(false);
    expect(containsUnsafeMermaidSource('graph TD\n A["<i>formatted</i>"]')).toBe(false);
    expect(containsUnsafeMermaidSource("sequenceDiagram\n  Alice->>Bob: a < b and x > y")).toBe(
      false,
    );
    expect(containsUnsafeMermaidSource("flowchart TD\n  A@{ shape: rect }")).toBe(true);
  });
});

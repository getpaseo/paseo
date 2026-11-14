import { describe, expect, it } from "vitest";
import { applyDefaultNodeShape } from "./node-shape";

const flowchart = `flowchart LR
  A[Start] --> B[Done]`;

describe("applyDefaultNodeShape", () => {
  it("leaves the source unchanged without a replacement shape", () => {
    expect(applyDefaultNodeShape(flowchart, undefined)).toBe(flowchart);
    expect(applyDefaultNodeShape(flowchart, "rect")).toBe(flowchart);
    expect(applyDefaultNodeShape(flowchart, "flag")).toBe(flowchart);
  });

  it("rewrites plain rectangles and keeps authored shapes", () => {
    const source = `flowchart TD
  A[Start] --> B(Already)
  C{Diamond}
  D([Stadium])
  E[(Cylinder)]
  F[[Sub]]
  G((Circle))
  H{{Hex}}
  J[/Input/]
  K[\\Input\\]
  L[/Input\\]
  M[\\Input/]
  I[Next]:::class`;
    expect(applyDefaultNodeShape(source, "rounded")).toBe(`flowchart TD
  A(Start) --> B(Already)
  C{Diamond}
  D([Stadium])
  E[(Cylinder)]
  F[[Sub]]
  G((Circle))
  H{{Hex}}
  J[/Input/]
  K[\\Input\\]
  L[/Input\\]
  M[\\Input/]
  I(Next):::class`);
  });

  it("supports the other plain-rectangle replacements", () => {
    expect(applyDefaultNodeShape("graph LR\nA[Start]", "diamond")).toBe("graph LR\nA{Start}");
    expect(applyDefaultNodeShape("flowchart LR\nA[Start]", "circle")).toBe(
      "flowchart LR\nA((Start))",
    );
    expect(applyDefaultNodeShape("flowchart LR\nA[Start]", "stadium")).toBe(
      "flowchart LR\nA([Start])",
    );
    expect(applyDefaultNodeShape("flowchart LR\nA[Start]", "cylinder")).toBe(
      "flowchart LR\nA[(Start)]",
    );
    expect(applyDefaultNodeShape("flowchart LR\nA[Start]", "subroutine")).toBe(
      "flowchart LR\nA[[Start]]",
    );
    expect(applyDefaultNodeShape("flowchart LR\nA[Start]", "hexagon")).toBe(
      "flowchart LR\nA{{Start}}",
    );
  });

  it("keeps subgraph titles and rewrites children", () => {
    const source = `flowchart LR
  subgraph group [Title]
    A[Start]
  end
  subgraph foo[Keep]
    B[Next]
  end`;
    expect(applyDefaultNodeShape(source, "diamond")).toBe(`flowchart LR
  subgraph group [Title]
    A{Start}
  end
  subgraph foo[Keep]
    B{Next}
  end`);
  });

  it("keeps apostrophes as label text", () => {
    expect(
      applyDefaultNodeShape("flowchart LR\nA[User's input] --> B[User's output]", "rounded"),
    ).toBe("flowchart LR\nA(User's input) --> B(User's output)");
    expect(applyDefaultNodeShape("flowchart LR\nA{don't} --> B[Next]", "rounded")).toBe(
      "flowchart LR\nA{don't} --> B(Next)",
    );
    expect(applyDefaultNodeShape("flowchart LR\nA[don't (stop)]", "rounded")).toBe(
      'flowchart LR\nA("don\'t (stop)")',
    );
  });

  it("rewrites children that share a line with a subgraph header", () => {
    expect(
      applyDefaultNodeShape("flowchart LR\nsubgraph group [Title]; A[Start]; end", "diamond"),
    ).toBe("flowchart LR\nsubgraph group [Title]; A{Start}; end");
  });

  it("ignores semicolons inside a quoted subgraph title", () => {
    expect(
      applyDefaultNodeShape(
        'flowchart LR\nsubgraph group["First; second"]\nA[Start]\nend',
        "diamond",
      ),
    ).toBe('flowchart LR\nsubgraph group["First; second"]\nA{Start}\nend');
    expect(
      applyDefaultNodeShape(
        'flowchart LR\nsubgraph group["First; second"]; A[Start]; end',
        "diamond",
      ),
    ).toBe('flowchart LR\nsubgraph group["First; second"]; A{Start}; end');
  });

  it("closes a quoted subgraph title at the next quote after a backslash", () => {
    expect(
      applyDefaultNodeShape('flowchart LR\nsubgraph g["C:\\"]\nA[Start]\nend', "diamond"),
    ).toBe('flowchart LR\nsubgraph g["C:\\"]\nA{Start}\nend');
  });

  it("leaves other diagram types and comments unchanged", () => {
    const sequence = "sequenceDiagram\n  Alice->>Bob: A[Start]";
    expect(applyDefaultNodeShape(sequence, "rounded")).toBe(sequence);
    const commented = "flowchart LR\n  %% A[Start]\n  B[Done]";
    expect(applyDefaultNodeShape(commented, "diamond")).toBe(
      "flowchart LR\n  %% A[Start]\n  B{Done}",
    );
  });

  it("rewrites a flowchart that follows frontmatter without touching the header", () => {
    const source = `---
title: A[Keep]
---
flowchart LR
  B[Change]`;
    expect(applyDefaultNodeShape(source, "rounded")).toBe(`---
title: A[Keep]
---
flowchart LR
  B(Change)`);
  });

  it("quotes a label that contains the target delimiter", () => {
    expect(applyDefaultNodeShape('flowchart LR\nA["a]b"]', "diamond")).toBe(
      'flowchart LR\nA{"a]b"}',
    );
    expect(applyDefaultNodeShape("flowchart LR\nA[a)b]", "rounded")).toBe('flowchart LR\nA("a)b")');
  });

  it("leaves edge-label brackets and an unclosed streaming node", () => {
    expect(applyDefaultNodeShape("flowchart LR\nA -->|label [note]| B[Done]", "rounded")).toBe(
      "flowchart LR\nA -->|label [note]| B(Done)",
    );
    expect(applyDefaultNodeShape("flowchart LR\nA -->|label[note]| B[Done]", "diamond")).toBe(
      "flowchart LR\nA -->|label[note]| B{Done}",
    );
    expect(applyDefaultNodeShape("flowchart LR\nA[Start", "rounded")).toBe("flowchart LR\nA[Start");
  });

  it("leaves bracketed text inside inline edge labels unchanged", () => {
    expect(applyDefaultNodeShape("flowchart LR\nA -- label[note] --> B[Done]", "rounded")).toBe(
      "flowchart LR\nA -- label[note] --> B(Done)",
    );
    expect(applyDefaultNodeShape("flowchart LR\nA -. label[note] .-> B[Done]", "diamond")).toBe(
      "flowchart LR\nA -. label[note] .-> B{Done}",
    );
    expect(applyDefaultNodeShape("flowchart LR\nA == label[note] ==> B[Done]", "stadium")).toBe(
      "flowchart LR\nA == label[note] ==> B([Done])",
    );
    expect(applyDefaultNodeShape('flowchart LR\nA -- "label[note]" --> B[Done]', "rounded")).toBe(
      'flowchart LR\nA -- "label[note]" --> B(Done)',
    );
    expect(
      applyDefaultNodeShape(
        "flowchart LR\nA -- first[tag] --> B[Done] -- second[tag] --> C[Done]",
        "rounded",
      ),
    ).toBe("flowchart LR\nA -- first[tag] --> B(Done) -- second[tag] --> C(Done)");
  });

  it("rewrites quoted nodes ending in a backslash and preserves subsequent nodes", () => {
    expect(applyDefaultNodeShape('flowchart LR\nA["C:\\"] --> B[Done]', "rounded")).toBe(
      'flowchart LR\nA("C:\\") --> B(Done)',
    );
    expect(applyDefaultNodeShape('flowchart LR\nA["C:\\"] --> B["D:\\"]', "diamond")).toBe(
      'flowchart LR\nA{"C:\\"} --> B{"D:\\"}',
    );
  });
});

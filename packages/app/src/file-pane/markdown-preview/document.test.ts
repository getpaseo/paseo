import { describe, expect, it } from "vitest";
import { parseMarkdownPreviewDocument } from "./document";

describe("parseMarkdownPreviewDocument", () => {
  it("separates YAML front matter from the Markdown body", () => {
    expect(
      parseMarkdownPreviewDocument(`---
name: release-beta
description: Cut a beta release
allowed-tools:
  - Bash
  - Read
---
# Release beta

Ship it.
`),
    ).toEqual({
      frontMatter: [
        { key: "name", value: "release-beta" },
        { key: "description", value: "Cut a beta release" },
        { key: "allowed-tools", value: "Bash, Read" },
      ],
      body: "# Release beta\n\nShip it.\n",
    });
  });

  it("formats nested metadata without flattening its meaning", () => {
    expect(
      parseMarkdownPreviewDocument(`---
metadata:
  audience: maintainers
  stable: true
---
Body
`),
    ).toEqual({
      frontMatter: [{ key: "metadata", value: "audience: maintainers\nstable: true" }],
      body: "Body\n",
    });
  });

  it("leaves the document intact when front matter is invalid", () => {
    const source = `---
name: [broken
---
Body
`;

    expect(parseMarkdownPreviewDocument(source)).toEqual({
      frontMatter: [],
      body: source,
    });
  });

  it("leaves the document intact when YAML conversion rejects excessive aliases", () => {
    const aliases = Array.from({ length: 101 }, () => "*item").join(", ");
    const source = `---
item: &item value
items: [${aliases}]
---
Body
`;

    expect(parseMarkdownPreviewDocument(source)).toEqual({
      frontMatter: [],
      body: source,
    });
  });

  it("does not treat a thematic break inside the document as front matter", () => {
    const source = `Introduction

---

Body
`;

    expect(parseMarkdownPreviewDocument(source)).toEqual({
      frontMatter: [],
      body: source,
    });
  });
});

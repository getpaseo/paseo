import { describe, expect, it } from "vitest";
import { resolveFilePanel, type FilePanelCandidate, type FilePanelFile } from "./resolve";

const markdown: FilePanelCandidate = {
  id: "builtin:markdown",
  files: { extensions: ["md", "markdown"] },
  document: "text",
  maxBytes: Infinity,
};
const alternative: FilePanelCandidate = { ...markdown, id: "plugin:notes/markdown" };
const file: FilePanelFile = { path: "/docs/README.MD", kind: "text", size: 100, hasBytes: true };

function resolve(
  overrides: Partial<Parameters<typeof resolveFilePanel<FilePanelCandidate>>[0]> = {},
) {
  return resolveFilePanel({
    file,
    candidates: [markdown, alternative],
    associations: {},
    ...overrides,
  });
}

describe("resolveFilePanel", () => {
  it("uses the associated candidate before catalog order", () => {
    expect(resolve({ associations: { "ext:md": alternative.id } })).toEqual({
      panel: alternative,
      candidates: [markdown, alternative],
      selectorKey: "ext:md",
    });
  });
  it("ignores an absent association without deleting it", () => {
    const associations = { "ext:md": "plugin:absent/markdown" };
    expect(resolve({ associations }).panel).toBe(markdown);
    expect(associations).toEqual({ "ext:md": "plugin:absent/markdown" });
  });
  it("uses a single candidate and preserves catalog order for multiple candidates", () => {
    expect(resolve({ candidates: [alternative] }).panel).toBe(alternative);
    expect(resolve().panel).toBe(markdown);
    expect(resolve({ candidates: [alternative, markdown] }).panel).toBe(alternative);
  });
  it("returns the floor when no selector matches", () => {
    expect(resolve({ file: { ...file, path: "index.ts" } })).toEqual({
      panel: null,
      candidates: [],
      selectorKey: "ext:ts",
    });
  });
  it("filters text panels for binary files even with an association", () => {
    expect(
      resolve({ file: { ...file, kind: "binary" }, associations: { "ext:md": markdown.id } }).panel,
    ).toBeNull();
  });
  it("requires bytes for bytes panels and accepts binary files with bytes", () => {
    const bytes: FilePanelCandidate = { ...alternative, document: "bytes" };
    expect(resolve({ file: { ...file, hasBytes: false }, candidates: [bytes] }).panel).toBeNull();
    expect(resolve({ file: { ...file, kind: "binary" }, candidates: [bytes] }).panel).toBe(bytes);
  });
  it("includes the maxBytes boundary and skips oversized associated panels", () => {
    const limited = { ...alternative, maxBytes: 100 };
    expect(resolve({ candidates: [limited] }).panel).toBe(limited);
    expect(
      resolve({
        file: { ...file, size: 101 },
        candidates: [limited, markdown],
        associations: { "ext:md": limited.id },
      }).panel,
    ).toBe(markdown);
  });
  it("uses exact basename keys when an eligible candidate matches by filename", () => {
    const named = { ...alternative, files: { extensions: [], filenames: ["README.MD"] } };
    expect(
      resolve({ candidates: [markdown, named], associations: { "name:README.MD": named.id } }),
    ).toEqual({
      panel: named,
      candidates: [markdown, named],
      selectorKey: "name:README.MD",
    });
    expect(resolve({ file: { ...file, path: "README.md" }, candidates: [named] }).panel).toBeNull();
  });
  it("uses extension keys when filename candidates were filtered out", () => {
    const named = {
      ...alternative,
      maxBytes: 1,
      files: { extensions: [], filenames: ["README.MD"] },
    };
    expect(resolve({ candidates: [named, markdown] }).selectorKey).toBe("ext:md");
  });
  it.each(["/src/Dockerfile", "C:\\src\\Dockerfile"])(
    "matches an extensionless exact filename: %s",
    (path) => {
      const named = { ...alternative, files: { extensions: [], filenames: ["Dockerfile"] } };
      expect(resolve({ file: { ...file, path }, candidates: [named] })).toEqual({
        panel: named,
        candidates: [named],
        selectorKey: "name:Dockerfile",
      });
    },
  );
  it("normalizes extension selectors and keeps extensionless files distinct", () => {
    const upper = { ...alternative, files: { extensions: ["MD"] } };
    expect(resolve({ candidates: [upper] }).panel).toBe(upper);
    expect(resolve({ file: { ...file, path: "README" } }).selectorKey).toBe("ext:");
  });
});

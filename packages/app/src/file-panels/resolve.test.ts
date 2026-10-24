import { describe, expect, it } from "vitest";
import { resolveFilePanel, type FilePanelCandidate, type FilePanelFile } from "./resolve";

const markdown: FilePanelCandidate = {
  id: "builtin:markdown",
  builtin: true,
  files: { extensions: ["md", "markdown"] },
  fileKind: "text",
};
const alternative: FilePanelCandidate = {
  id: "plugin:notes/markdown",
  builtin: false,
  files: { extensions: ["md", "markdown"] },
};
const file: FilePanelFile = { path: "/docs/README.MD", kind: "text" };

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
      associatedPanelId: alternative.id,
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
  it("uses a tab choice before the association and ignores a choice that is not a candidate", () => {
    const associations = { "ext:md": alternative.id };
    expect(resolve({ associations, choice: markdown.id })).toMatchObject({
      panel: markdown,
      associatedPanelId: alternative.id,
    });
    expect(resolve({ associations, choice: "plugin:absent/markdown" }).panel).toBe(alternative);
  });
  it("returns the floor when no selector matches", () => {
    expect(resolve({ file: { ...file, path: "index.ts" } })).toEqual({
      panel: null,
      candidates: [],
      selectorKey: "ext:ts",
      associatedPanelId: null,
    });
  });
  it("offers a panel claiming every file of its kind for files of that kind", () => {
    const every: FilePanelCandidate = { ...markdown, id: "builtin:source", files: "all" };
    expect(resolve({ file: { ...file, path: "index.ts" }, candidates: [every] })).toEqual({
      panel: every,
      candidates: [every],
      selectorKey: "ext:ts",
      associatedPanelId: null,
    });
    expect(resolve({ file: { ...file, kind: "binary" }, candidates: [every] }).panel).toBeNull();
  });
  it("offers a built-in panel claiming every file only when no other built-in claims the file", () => {
    const every: FilePanelCandidate = { ...markdown, id: "builtin:source", files: "all" };
    expect(resolve({ candidates: [markdown, alternative, every] }).candidates).toEqual([
      markdown,
      alternative,
    ]);
    expect(resolve({ candidates: [alternative, every] }).candidates).toEqual([alternative, every]);
    expect(
      resolve({ file: { ...file, kind: "binary" }, candidates: [markdown, every] }).candidates,
    ).toEqual([]);
  });
  it("passes over a built-in panel for another kind of file, even with an association", () => {
    expect(
      resolve({ file: { ...file, kind: "binary" }, associations: { "ext:md": markdown.id } }).panel,
    ).toBe(alternative);
  });
  it("offers plugin panels for every kind of file their selector matches", () => {
    for (const kind of ["text", "image", "binary"] as const) {
      expect(resolve({ file: { ...file, kind }, candidates: [alternative] }).panel).toBe(
        alternative,
      );
    }
  });
  it("uses exact basename keys when an eligible candidate matches by filename", () => {
    const named = { ...alternative, files: { extensions: [], filenames: ["README.MD"] } };
    expect(
      resolve({ candidates: [markdown, named], associations: { "name:README.MD": named.id } }),
    ).toEqual({
      panel: named,
      candidates: [markdown, named],
      selectorKey: "name:README.MD",
      associatedPanelId: named.id,
    });
    expect(resolve({ file: { ...file, path: "README.md" }, candidates: [named] }).panel).toBeNull();
  });
  it("uses extension keys when filename candidates were filtered out", () => {
    const named = {
      ...markdown,
      id: "builtin:named",
      files: { extensions: [], filenames: ["README.MD"] },
    };
    expect(
      resolve({ file: { ...file, kind: "binary" }, candidates: [named, alternative] }).selectorKey,
    ).toBe("ext:md");
  });
  it.each(["/src/Dockerfile", "C:\\src\\Dockerfile"])(
    "matches an extensionless exact filename: %s",
    (path) => {
      const named = { ...alternative, files: { extensions: [], filenames: ["Dockerfile"] } };
      expect(resolve({ file: { ...file, path }, candidates: [named] })).toEqual({
        panel: named,
        candidates: [named],
        selectorKey: "name:Dockerfile",
        associatedPanelId: null,
      });
    },
  );
  it("normalizes extension selectors and keeps extensionless files distinct", () => {
    const upper = { ...alternative, files: { extensions: ["MD"] } };
    expect(resolve({ candidates: [upper] }).panel).toBe(upper);
    expect(resolve({ file: { ...file, path: "README" } }).selectorKey).toBe("ext:");
  });
});

it("opens a binary PDF with its plugin by its selector alone", () => {
  const pdf: FilePanelCandidate = {
    id: "plugin:pdf/viewer",
    builtin: false,
    files: { extensions: ["pdf"] },
  };
  const pdfFile: FilePanelFile = { path: "/workspace/document.pdf", kind: "binary" };
  expect(
    resolveFilePanel({ file: pdfFile, candidates: [markdown, pdf], associations: {} }).panel,
  ).toBe(pdf);
});

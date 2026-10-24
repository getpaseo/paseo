import { describe, expect, it } from "vitest";
import { filePanelCatalog } from "./catalog";
import { resolveFilePanel, type FilePanelCandidate, type FilePanelFile } from "./resolve";

const builtins = filePanelCatalog([]);

const richMarkdown: FilePanelCandidate = {
  id: "plugin:notes/rich",
  builtin: false,
  files: { extensions: ["md"] },
};

function textFile(path: string): FilePanelFile {
  return { path, kind: "text" };
}

function candidateIds(file: FilePanelFile, candidates: readonly FilePanelCandidate[] = builtins) {
  return resolveFilePanel({ file, candidates, associations: {} }).candidates.map(
    (candidate) => candidate.id,
  );
}

function panelId(file: FilePanelFile, candidates: readonly FilePanelCandidate[] = builtins) {
  return resolveFilePanel({ file, candidates, associations: {} }).panel?.id ?? null;
}

describe("built-in file panels", () => {
  it("opens each rendered extension with its panel alone, never with Source beside it", () => {
    expect(candidateIds(textFile("README.md"))).toEqual(["builtin:markdown"]);
    expect(candidateIds(textFile("plan.html"))).toEqual(["builtin:html"]);
    expect(panelId(textFile("notes.markdown"))).toBe("builtin:markdown");
    expect(panelId(textFile("plan.html"))).toBe("builtin:html");
    expect(panelId(textFile("docs/PLAN.HTML"))).toBe("builtin:html");
    expect(panelId(textFile("plan.htm"))).toBe("builtin:html");
  });

  it("opens every other text file with Source, whatever its name", () => {
    for (const path of ["src/index.ts", "page.mdx", "index.html.erb", "Dockerfile", "LICENSE"]) {
      expect(candidateIds(textFile(path))).toEqual(["builtin:source"]);
    }
  });

  it("puts plugin panels after the built-in that claims the file, and before Source", () => {
    expect(candidateIds(textFile("README.md"), filePanelCatalog([richMarkdown]))).toEqual([
      "builtin:markdown",
      richMarkdown.id,
    ]);
    const onlyPlugin = filePanelCatalog([{ ...richMarkdown, files: { extensions: ["txt"] } }]);
    expect(candidateIds(textFile("notes.txt"), onlyPlugin)).toEqual([
      richMarkdown.id,
      "builtin:source",
    ]);
    expect(panelId(textFile("notes.txt"), onlyPlugin)).toBe(richMarkdown.id);
  });

  it("ignores a remembered Source for a file another built-in claims", () => {
    const resolution = resolveFilePanel({
      file: textFile("README.md"),
      candidates: builtins,
      associations: { "ext:md": "builtin:source" },
    });
    expect(resolution.panel?.id).toBe("builtin:markdown");
    expect(resolution.associatedPanelId).toBeNull();
  });

  it("has no Source for files that are not text", () => {
    expect(candidateIds({ path: "archive.zip", kind: "binary" })).toEqual([]);
  });

  it.each(["png", "jpg", "jpeg", "gif", "webp", "svg"])(
    "registers the image extension %s",
    (extension) => {
      const resolution = resolveFilePanel({
        file: { path: `/capture.${extension.toUpperCase()}`, kind: "image" },
        candidates: builtins,
        associations: { [`ext:${extension}`]: "builtin:markdown" },
      });
      expect(resolution.panel?.id).toBe("builtin:image");
      expect(
        resolveFilePanel({
          file: { path: "capture.png", kind: "binary" },
          candidates: builtins,
          associations: {},
        }).panel,
      ).toBeNull();
    },
  );
});

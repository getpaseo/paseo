import { describe, expect, it } from "vitest";
import {
  FILENAMES_TYPE,
  parseFilenamesPlist,
  parseUriList,
  readClipboardFilePaths,
  type ClipboardItemLike,
} from "./clipboard-file-paths.js";

function item(formats: Record<string, string>): ClipboardItemLike {
  return {
    types: Object.keys(formats),
    getType: async (type) => {
      if (!(type in formats)) throw new Error(`missing ${type}`);
      return new Blob([formats[type]!]);
    },
  };
}

const plist = (paths: string[]) =>
  `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><array>${paths
    .map((p) => `\n\t<string>${p}</string>`)
    .join("")}</array></plist>`;

describe("readClipboardFilePaths", () => {
  it("returns every path Finder copied, dropping trailing slashes", async () => {
    const paths = await readClipboardFilePaths({
      read: async () => [
        item({
          "text/plain": "phd",
          [FILENAMES_TYPE]: plist(["/Users/x/finance-solution/phd/", "/Users/x/a &amp; b.md"]),
          "text/uri-list": "file:///ignored",
        }),
      ],
    });
    expect(paths).toEqual(["/Users/x/finance-solution/phd", "/Users/x/a & b.md"]);
  });

  it("falls back to the URI list and decodes it", async () => {
    const paths = await readClipboardFilePaths({
      read: async () => [
        item({ "text/uri-list": "file:///Users/x/My%20Notes/\r\nfile:///Users/x/phd" }),
      ],
    });
    expect(paths).toEqual(["/Users/x/My Notes", "/Users/x/phd"]);
  });

  it("returns nothing for a text-only clipboard", async () => {
    expect(
      await readClipboardFilePaths({ read: async () => [item({ "text/plain": "phd" })] }),
    ).toEqual([]);
  });

  it("gives up on a clipboard read that fails", async () => {
    expect(
      await readClipboardFilePaths({ read: async () => Promise.reject(new Error("denied")) }),
    ).toEqual([]);
  });

  it("parses plists and URI lists strictly", () => {
    expect(parseFilenamesPlist(plist(["relative", "/abs"]))).toEqual(["/abs"]);
    expect(parseUriList("# comment\nhttps://x.com\nfile:///a")).toEqual(["/a"]);
  });
});

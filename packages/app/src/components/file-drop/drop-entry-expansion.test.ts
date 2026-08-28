import { describe, expect, test } from "vitest";
import { expandDropEntry } from "./use-drop-listeners";

/** Minimal stand-ins for the DataTransfer entry API, which jsdom does not implement. */
function fileEntry(name: string, body: string) {
  return {
    isFile: true,
    isDirectory: false,
    name,
    file: (resolve: (file: File) => void) => resolve(new File([body], name)),
  } as unknown as FileSystemEntry;
}

function dirEntry(name: string, children: FileSystemEntry[]) {
  return {
    isFile: false,
    isDirectory: true,
    name,
    createReader: () => {
      let served = false;
      return {
        // The real API yields in batches and signals the end with an empty array.
        readEntries: (resolve: (entries: FileSystemEntry[]) => void) => {
          resolve(served ? [] : children);
          served = true;
        },
      };
    },
  } as unknown as FileSystemEntry;
}

describe("expandDropEntry", () => {
  test("leaves a plain dropped file without a tree path", async () => {
    const items = await expandDropEntry(fileEntry("a.txt", "alpha"), "");
    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe("web-file");
    // A tree path here would make the upload look like a folder and take the
    // folder overwrite policy, which is how a dropped file could clobber one in the repo.
    expect(items[0].relativePath).toBeUndefined();
  });

  test("recurses into a folder and preserves the tree shape", async () => {
    const tree = dirEntry("site", [
      fileEntry("index.html", "<html>"),
      dirEntry("assets", [fileEntry("logo.png", "png")]),
    ]);

    const items = await expandDropEntry(tree, "");
    expect(items.map((item) => item.relativePath).sort()).toEqual([
      "site/assets/logo.png",
      "site/index.html",
    ]);
  });

  test("handles nesting deeper than one level", async () => {
    const tree = dirEntry("a", [dirEntry("b", [dirEntry("c", [fileEntry("deep.txt", "x")])])]);
    const items = await expandDropEntry(tree, "");
    expect(items.map((item) => item.relativePath)).toEqual(["a/b/c/deep.txt"]);
  });

  test("returns nothing for an empty folder", async () => {
    const items = await expandDropEntry(dirEntry("empty", []), "");
    expect(items).toEqual([]);
  });

  test("skips a file the browser refuses to read instead of failing the whole drop", async () => {
    const unreadable = {
      isFile: true,
      isDirectory: false,
      name: "locked.txt",
      file: (_resolve: unknown, reject: () => void) => reject(),
    } as unknown as FileSystemEntry;

    const tree = dirEntry("mixed", [unreadable, fileEntry("ok.txt", "fine")]);
    const items = await expandDropEntry(tree, "");
    expect(items.map((item) => item.relativePath)).toEqual(["mixed/ok.txt"]);
  });

  test("ignores an entry that is neither a file nor a directory", async () => {
    const odd = { isFile: false, isDirectory: false, name: "?" } as unknown as FileSystemEntry;
    expect(await expandDropEntry(odd, "")).toEqual([]);
  });
});

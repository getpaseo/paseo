import { describe, expect, it, vi } from "vitest";
import type { DesktopHostBridge } from "@/desktop/host";
import {
  formatPastedPaths,
  looksLikeCopiedFileNames,
  pasteCopiedFilePaths,
  pastedFilePathsFromItems,
  pathsMatchCopiedNames,
} from "./pasted-file-paths";

function clipboard(text: string, files: File[] = []) {
  const items = files.map((file) => ({ kind: "file", type: file.type, getAsFile: () => file }));
  return {
    getData: (type: string) => (type === "text/plain" ? text : ""),
    items: items as unknown as DataTransferItemList,
  };
}

function fakeInput() {
  const inserted: string[] = [];
  const input = {
    focus: vi.fn(),
    ownerDocument: {
      execCommand: (_command: string, _ui: boolean, value: string) => {
        inserted.push(value);
        return true;
      },
    },
  } as unknown as HTMLElement;
  return { input, inserted };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("pasted file paths", () => {
  it("formats paths like a terminal paste, quoting whitespace", () => {
    expect(formatPastedPaths(["/Users/x/phd", "/Users/x/My Notes"])).toBe(
      '/Users/x/phd "/Users/x/My Notes"',
    );
  });

  it("recognises Finder item names but not prose, code or paths", () => {
    expect(looksLikeCopiedFileNames("phd")).toBe(true);
    expect(looksLikeCopiedFileNames("phd\nreport.pdf")).toBe(true);
    expect(looksLikeCopiedFileNames("/Users/x/phd")).toBe(false);
    expect(looksLikeCopiedFileNames("")).toBe(false);
    expect(looksLikeCopiedFileNames("  indented code")).toBe(false);
  });

  it("only replaces text that names the copied items", () => {
    expect(pathsMatchCopiedNames(["/Users/x/finance-solution/phd"], "phd")).toBe(true);
    expect(pathsMatchCopiedNames(["/Users/x/a", "/Users/x/b.md"], "a\rb.md")).toBe(true);
    expect(pathsMatchCopiedNames(["/Users/x/other"], "phd")).toBe(false);
    expect(pathsMatchCopiedNames([], "phd")).toBe(false);
  });

  it("uses file items the browser exposes", () => {
    const file = new File([], "phd");
    const paths = pastedFilePathsFromItems(clipboard("phd", [file]), () => "/Users/x/phd");
    expect(paths).toEqual(["/Users/x/phd"]);
    expect(pastedFilePathsFromItems(clipboard("phd", [file]), () => "")).toEqual([]);
  });

  it("asks the desktop for Finder paths and inserts them", async () => {
    const { input, inserted } = fakeInput();
    const host: DesktopHostBridge = {
      clipboard: {
        readFilePaths: async () => ["/Users/Xhacker/Documents/pt/finance-solution/phd"],
      },
    };
    expect(pasteCopiedFilePaths(input, clipboard("phd"), host)).toBe(true);
    await flush();
    expect(inserted).toEqual(["/Users/Xhacker/Documents/pt/finance-solution/phd"]);
  });

  it("puts the original text back when the clipboard holds no matching files", async () => {
    const { input, inserted } = fakeInput();
    const host: DesktopHostBridge = { clipboard: { readFilePaths: async () => [] } };
    expect(pasteCopiedFilePaths(input, clipboard("hello"), host)).toBe(true);
    await flush();
    expect(inserted).toEqual(["hello"]);
  });

  it("leaves ordinary pastes and the web build alone", () => {
    const { input, inserted } = fakeInput();
    const host: DesktopHostBridge = { clipboard: { readFilePaths: async () => ["/x"] } };
    expect(pasteCopiedFilePaths(input, clipboard("see /Users/x/phd"), host)).toBe(false);
    expect(pasteCopiedFilePaths(input, clipboard("phd"), null)).toBe(false);
    expect(inserted).toEqual([]);
  });

  it("does not insert after the composer is gone", async () => {
    const { input, inserted } = fakeInput();
    const host: DesktopHostBridge = { clipboard: { readFilePaths: async () => ["/Users/x/phd"] } };
    pasteCopiedFilePaths(input, clipboard("phd"), host, () => true);
    await flush();
    expect(inserted).toEqual([]);
  });
});

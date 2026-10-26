import { describe, expect, it } from "vitest";
import { detectTerminalLocalLinks } from "./terminal-local-link-parsing";

describe("detectTerminalLocalLinks", () => {
  it.each([
    ["user@host:~/projects$ ls", 10, "~/projects"],
    ["root@host:/etc/nginx# ", 10, "/etc/nginx"],
    ["user@host ~/src% ", 10, "~/src"],
    ["(base) user@host:~/projects$", 17, "~/projects"],
  ])("excludes the prompt marker in %s", (line, index, text) => {
    expect(detectTerminalLocalLinks(line)).toMatchObject([
      { path: { index, text }, suffix: undefined },
    ]);
  });

  it.each(["$", "#", "%"])("preserves a filename ending in %s", (marker) => {
    const path = `/tmp/report${marker}`;
    expect(detectTerminalLocalLinks(`cat ${path}`)).toMatchObject([
      { path: { index: 4, text: path }, suffix: undefined },
    ]);
  });

  it("detects VS Code-style filename and line suffixes", () => {
    expect(detectTerminalLocalLinks("file.ts:42")).toMatchObject([
      {
        path: { index: 0, text: "file.ts" },
        suffix: { row: 42, col: undefined, rowEnd: undefined },
      },
    ]);
  });

  it("detects line and column suffixes", () => {
    expect(detectTerminalLocalLinks("src/file.ts:42:7")).toMatchObject([
      {
        path: { index: 0, text: "src/file.ts" },
        suffix: { row: 42, col: 7, rowEnd: undefined },
      },
    ]);
  });

  it("detects quoted Python traceback paths", () => {
    expect(detectTerminalLocalLinks('  File "pkg/file.py", line 12')).toMatchObject([
      {
        path: { index: 8, text: "pkg/file.py" },
        suffix: { row: 12 },
      },
    ]);
  });

  it("detects paths without suffixes", () => {
    expect(detectTerminalLocalLinks("changed packages/app/src/file.ts")).toMatchObject([
      {
        path: { index: 8, text: "packages/app/src/file.ts" },
        suffix: undefined,
      },
    ]);
  });
});

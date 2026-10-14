import { describe, expect, it } from "vitest";
import { detectTerminalLocalLinks } from "./terminal-local-link-parsing";

describe("detectTerminalLocalLinks", () => {
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

  it("excludes the shell prompt terminator from a prompt's working directory", () => {
    expect(detectTerminalLocalLinks("user@host:~/projects$ ls")).toMatchObject([
      { path: { index: 10, text: "~/projects" }, suffix: undefined },
    ]);
    expect(detectTerminalLocalLinks("root@host:/etc/nginx# ")).toMatchObject([
      { path: { index: 10, text: "/etc/nginx" }, suffix: undefined },
    ]);
    expect(detectTerminalLocalLinks("user@host ~/src% ")).toMatchObject([
      { path: { index: 10, text: "~/src" }, suffix: undefined },
    ]);
  });

  it("keeps a dollar sign inside a path", () => {
    expect(detectTerminalLocalLinks("cat src/$id/page.tsx")).toMatchObject([
      { path: { index: 4, text: "src/$id/page.tsx" }, suffix: undefined },
    ]);
  });
});

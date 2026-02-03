import { describe, expect, test } from "vitest";
import {
  stripShellWrapperPrefix,
  extractPrincipalParam,
  stripCwdPrefix,
} from "./tool-call-parsers.js";

describe("stripShellWrapperPrefix", () => {
  test("strips /bin/zsh -lc cd path && prefix", () => {
    const command = "/bin/zsh -lc cd /Users/moboudra/dev/blankpage/editor && npm run format";
    expect(stripShellWrapperPrefix(command)).toBe("npm run format");
  });

  test("strips /bin/zsh -lc \"cd path &&\" wrapper", () => {
    const command = '/bin/zsh -lc "cd /Users/moboudra/dev/blankpage/editor && npm run format"';
    expect(stripShellWrapperPrefix(command)).toBe("npm run format");
  });

  test("strips /bin/zsh -c cd path && prefix", () => {
    const command = "/bin/zsh -c cd /path/to/project && git status";
    expect(stripShellWrapperPrefix(command)).toBe("git status");
  });

  test("strips /bin/bash -lc cd path && prefix", () => {
    const command = "/bin/bash -lc cd /home/user/project && npm test";
    expect(stripShellWrapperPrefix(command)).toBe("npm test");
  });

  test("strips /bin/sh -c cd path && prefix", () => {
    const command = "/bin/sh -c cd /tmp && ls -la";
    expect(stripShellWrapperPrefix(command)).toBe("ls -la");
  });

  test("returns command unchanged when no prefix", () => {
    const command = "npm run build";
    expect(stripShellWrapperPrefix(command)).toBe("npm run build");
  });

  test("returns command unchanged for partial match", () => {
    const command = "/bin/zsh -lc npm run build";
    expect(stripShellWrapperPrefix(command)).toBe("/bin/zsh -lc npm run build");
  });

  test("strips when cd path includes spaces in quotes", () => {
    const command = '/bin/zsh -lc cd "/path with spaces" && npm test';
    expect(stripShellWrapperPrefix(command)).toBe("npm test");
  });
});

describe("extractPrincipalParam", () => {
  test("extracts and strips shell wrapper from command string", () => {
    const args = { command: "/bin/zsh -lc cd /Users/dev/project && npm run format" };
    expect(extractPrincipalParam(args)).toBe("npm run format");
  });

  test("extracts and strips shell wrapper from command array", () => {
    const args = { command: ["/bin/bash", "-lc", "cd /path && git status"] };
    // Array is joined with spaces first: "/bin/bash -lc cd /path && git status"
    // Then shell wrapper is stripped
    expect(extractPrincipalParam(args)).toBe("git status");
  });

  test("extracts plain command without shell wrapper", () => {
    const args = { command: "npm run build" };
    expect(extractPrincipalParam(args)).toBe("npm run build");
  });

  test("extracts file_path and strips cwd", () => {
    const args = { file_path: "/Users/dev/project/src/file.ts" };
    expect(extractPrincipalParam(args, "/Users/dev/project")).toBe("src/file.ts");
  });

  test("extracts pattern without modification", () => {
    const args = { pattern: "*.ts" };
    expect(extractPrincipalParam(args)).toBe("*.ts");
  });

  test("extracts query without modification", () => {
    const args = { query: "search term" };
    expect(extractPrincipalParam(args)).toBe("search term");
  });

  test("extracts url without modification", () => {
    const args = { url: "https://example.com" };
    expect(extractPrincipalParam(args)).toBe("https://example.com");
  });

  test("returns undefined for empty object", () => {
    expect(extractPrincipalParam({})).toBeUndefined();
  });
});

describe("stripCwdPrefix", () => {
  test("strips cwd prefix from file path", () => {
    expect(stripCwdPrefix("/Users/dev/project/src/file.ts", "/Users/dev/project")).toBe("src/file.ts");
  });

  test("returns . for exact cwd match", () => {
    expect(stripCwdPrefix("/Users/dev/project", "/Users/dev/project")).toBe(".");
  });

  test("returns path unchanged when no cwd prefix", () => {
    expect(stripCwdPrefix("/other/path/file.ts", "/Users/dev/project")).toBe("/other/path/file.ts");
  });

  test("returns path unchanged when no cwd provided", () => {
    expect(stripCwdPrefix("/Users/dev/project/file.ts")).toBe("/Users/dev/project/file.ts");
  });
});

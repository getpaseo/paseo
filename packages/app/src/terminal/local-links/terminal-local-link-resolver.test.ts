import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { describe, expect, it } from "vitest";
import type { TerminalLocalFileLinkSource } from "./terminal-local-link-provider";
import { resolveTerminalLocalFileLink } from "./terminal-local-link-resolver";

type Query = Parameters<DaemonClient["getDirectorySuggestions"]>[0];
type Result = Awaited<ReturnType<DaemonClient["getDirectorySuggestions"]>>;

function createHost(entries: Result["entries"], error: string | null = null) {
  const queries: Query[] = [];
  const getDirectorySuggestions: DaemonClient["getDirectorySuggestions"] = async (query) => {
    queries.push(query);
    return { directories: [], entries, error, requestId: "test-directory-lookup" };
  };
  return { queries, getDirectorySuggestions };
}

function source(text: string): TerminalLocalFileLinkSource {
  return { text, path: text };
}

describe("resolveTerminalLocalFileLink", () => {
  it.each([
    { token: "/etc/hosts", path: "/etc/hosts", cwd: "/", relative: "etc/hosts" },
    { token: "/notes.txt", path: "/notes.txt", cwd: "/", relative: "notes.txt" },
    {
      token: "~/.codex/config.toml",
      path: "~/.codex/config.toml",
      cwd: "~",
      relative: ".codex/config.toml",
    },
    { token: "~/.zshrc", path: "~/.zshrc", cwd: "~", relative: ".zshrc" },
    { token: "/repo/src/app.ts", path: "/repo/src/app.ts", cwd: "/repo", relative: "src/app.ts" },
    {
      token: "C:/Users/me/notes.txt",
      path: "C:/Users/me/notes.txt",
      cwd: "C:/",
      relative: "Users/me/notes.txt",
    },
    { token: "C:/boot.ini", path: "C:/boot.ini", cwd: "C:/", relative: "boot.ini" },
    {
      token: "C:\\Users\\me\\notes.txt",
      path: "C:/Users/me/notes.txt",
      cwd: "C:/",
      relative: "Users/me/notes.txt",
    },
    { token: "file:///etc/hosts", path: "/etc/hosts", cwd: "/", relative: "etc/hosts" },
  ])("validates $token through the file preview's root", async ({ token, path, cwd, relative }) => {
    const host = createHost([{ path: relative, kind: "file" }]);

    const target = await resolveTerminalLocalFileLink({
      source: source(token),
      canValidateExactPaths: true,
      workspaceRoot: "/repo",
      getDirectorySuggestions: host.getDirectorySuggestions,
    });

    expect(target).toMatchObject({ path });
    expect(host.queries).toEqual([
      {
        cwd,
        query: `./${relative}`,
        includeFiles: true,
        includeDirectories: false,
        matchMode: "suffix",
        exactOnly: true,
        limit: 1,
      },
    ]);
  });

  it("preserves an exact Unicode filename instead of removing its Korean ending", async () => {
    const host = createHost([{ path: ".codex/config.toml의", kind: "file" }]);
    const target = await resolveTerminalLocalFileLink({
      source: source("~/.codex/config.toml의:3-5"),
      canValidateExactPaths: true,
      workspaceRoot: "/repo",
      getDirectorySuggestions: host.getDirectorySuggestions,
    });
    expect(target).toMatchObject({ path: "~/.codex/config.toml의", lineStart: 3, lineEnd: 5 });
  });

  it("uses the host's exact-path result rather than guessing filesystem case rules", async () => {
    const host = createHost([{ path: "etc/Hosts", kind: "file" }]);
    const target = await resolveTerminalLocalFileLink({
      source: source("/etc/Hosts"),
      canValidateExactPaths: true,
      workspaceRoot: "/repo",
      getDirectorySuggestions: host.getDirectorySuggestions,
    });
    expect(target).toMatchObject({ path: "/etc/Hosts" });
  });

  it.each([
    { entries: [] },
    { entries: [{ path: ".codex/config.toml", kind: "file" as const }] },
    { entries: [{ path: "nested/.codex/config.toml의", kind: "file" as const }] },
    { entries: [{ path: ".codex/config.toml의", kind: "directory" as const }] },
  ])("rejects missing paths, alternatives, and directories: %j", async ({ entries }) => {
    const host = createHost(entries);
    const target = await resolveTerminalLocalFileLink({
      source: source("~/.codex/config.toml의"),
      canValidateExactPaths: true,
      workspaceRoot: "/repo",
      getDirectorySuggestions: host.getDirectorySuggestions,
    });
    expect(target).toBeNull();
  });

  it("rejects a response that reports an error", async () => {
    const host = createHost([{ path: "etc/hosts", kind: "file" }], "Permission denied");
    await expect(
      resolveTerminalLocalFileLink({
        source: source("/etc/hosts"),
        workspaceRoot: "/repo",
        canValidateExactPaths: true,
        getDirectorySuggestions: host.getDirectorySuggestions,
      }),
    ).resolves.toBeNull();
  });

  it("does not expose a link when the host is disconnected or its request fails", async () => {
    await expect(
      resolveTerminalLocalFileLink({
        source: source("/etc/hosts"),
        workspaceRoot: "/repo",
        canValidateExactPaths: true,
        getDirectorySuggestions: null,
      }),
    ).resolves.toBeNull();
    await expect(
      resolveTerminalLocalFileLink({
        source: source("/etc/hosts"),
        workspaceRoot: "/repo",
        canValidateExactPaths: true,
        getDirectorySuggestions: async () => {
          throw new Error("Disconnected");
        },
      }),
    ).resolves.toBeNull();
  });

  it("does not send an exact lookup to a host that could fall back to scanning its tree", async () => {
    const host = createHost([{ path: "etc/hosts", kind: "file" }]);
    await expect(
      resolveTerminalLocalFileLink({
        source: source("/etc/hosts"),
        workspaceRoot: "/repo",
        canValidateExactPaths: false,
        getDirectorySuggestions: host.getDirectorySuggestions,
      }),
    ).resolves.toBeNull();
    expect(host.queries).toEqual([]);
  });

  it("does not reinterpret an unscoped UNC share as a local directory", async () => {
    const host = createHost([{ path: "server/share/a.txt", kind: "file" }]);
    await expect(
      resolveTerminalLocalFileLink({
        source: source("//server/share/a.txt"),
        workspaceRoot: "/repo",
        canValidateExactPaths: true,
        getDirectorySuggestions: host.getDirectorySuggestions,
      }),
    ).resolves.toBeNull();
    expect(host.queries).toEqual([]);
  });

  it("keeps workspace-relative suffix search and line ranges on older hosts", async () => {
    const host = createHost([{ path: "src/nested/file.ts", kind: "file" }]);
    const target = await resolveTerminalLocalFileLink({
      source: source("file.ts:42-44"),
      workspaceRoot: "/repo",
      canValidateExactPaths: false,
      getDirectorySuggestions: host.getDirectorySuggestions,
    });
    expect(target).toMatchObject({ path: "/repo/src/nested/file.ts", lineStart: 42, lineEnd: 44 });
    expect(host.queries).toEqual([
      {
        query: "file.ts",
        cwd: "/repo",
        includeFiles: true,
        includeDirectories: false,
        matchMode: "suffix",
        limit: 1,
      },
    ]);
  });
});

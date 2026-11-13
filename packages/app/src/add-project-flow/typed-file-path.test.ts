import { describe, expect, it, vi } from "vitest";
import { findTypedFilePath, locateTypedPath, type TypedFileClient } from "./typed-file-path";

type DirectorySuggestionsPayload = Awaited<ReturnType<TypedFileClient["getDirectorySuggestions"]>>;

function suggestionsPayload(
  entries: DirectorySuggestionsPayload["entries"],
  error: string | null = null,
): DirectorySuggestionsPayload {
  return {
    directories: entries.flatMap((entry) => (entry.kind === "directory" ? [entry.path] : [])),
    entries,
    error,
    requestId: "request",
  };
}

function fakeClient(answer: () => Promise<DirectorySuggestionsPayload>) {
  const getDirectorySuggestions = vi.fn<TypedFileClient["getDirectorySuggestions"]>(answer);
  return { client: { getDirectorySuggestions }, getDirectorySuggestions };
}

describe("locateTypedPath", () => {
  it("splits absolute and home-relative paths into parent and name", () => {
    expect(locateTypedPath("/a.txt")).toEqual({ parent: "/", name: "a.txt" });
    expect(locateTypedPath(" /tmp/x/a.txt ")).toEqual({ parent: "/tmp/x", name: "a.txt" });
    expect(locateTypedPath("//tmp//x/a.txt")).toEqual({ parent: "/tmp/x", name: "a.txt" });
    expect(locateTypedPath("~/x/y.md")).toEqual({ parent: "~/x", name: "y.md" });
    expect(locateTypedPath("~/y.md")).toEqual({ parent: "~", name: "y.md" });
  });

  it("ignores queries that cannot name a file", () => {
    expect(locateTypedPath("")).toBeNull();
    expect(locateTypedPath("repo")).toBeNull();
    expect(locateTypedPath("src/a.txt")).toBeNull();
    expect(locateTypedPath("/")).toBeNull();
    expect(locateTypedPath("~")).toBeNull();
    expect(locateTypedPath("~/")).toBeNull();
    expect(locateTypedPath("/tmp/x/")).toBeNull();
    expect(locateTypedPath("/tmp/..")).toBeNull();
    expect(locateTypedPath("/tmp/a\\b.txt")).toBeNull();
  });
});

describe("findTypedFilePath", () => {
  it("asks the daemon for exactly the typed name in the typed directory", async () => {
    const { client, getDirectorySuggestions } = fakeClient(async () =>
      suggestionsPayload([{ path: "y.md", kind: "file" }]),
    );

    await expect(findTypedFilePath({ query: "~/x/y.md", client })).resolves.toEqual({
      parent: "~/x",
      name: "y.md",
    });
    expect(getDirectorySuggestions).toHaveBeenCalledWith({
      cwd: "~/x",
      query: "y.md",
      includeFiles: true,
      includeDirectories: false,
      matchMode: "exact",
      limit: 1,
    });
  });

  it("finds a file at the filesystem root", async () => {
    const { client, getDirectorySuggestions } = fakeClient(async () =>
      suggestionsPayload([{ path: "a.txt", kind: "file" }]),
    );

    await expect(findTypedFilePath({ query: "/a.txt", client })).resolves.toEqual({
      parent: "/",
      name: "a.txt",
    });
    expect(getDirectorySuggestions).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: "/", query: "a.txt" }),
    );
  });

  it("offers nothing when the typed path is not a file", async () => {
    const { client } = fakeClient(async () => suggestionsPayload([]));

    await expect(findTypedFilePath({ query: "/tmp/x/nested", client })).resolves.toBeNull();
  });

  it("does not ask about a query that is not a rooted path", async () => {
    const { client, getDirectorySuggestions } = fakeClient(async () => suggestionsPayload([]));

    await expect(findTypedFilePath({ query: "repo", client })).resolves.toBeNull();
    expect(getDirectorySuggestions).not.toHaveBeenCalled();
  });

  it("fails instead of guessing when the lookup fails", async () => {
    const daemonError = fakeClient(async () => suggestionsPayload([], "EACCES"));
    const disconnected = fakeClient(async () => {
      throw new Error("Connection closed");
    });

    await expect(
      findTypedFilePath({ query: "/tmp/x/y.md", client: daemonError.client }),
    ).rejects.toThrow("EACCES");
    await expect(
      findTypedFilePath({ query: "/tmp/x/y.md", client: disconnected.client }),
    ).rejects.toThrow("Connection closed");
  });
});

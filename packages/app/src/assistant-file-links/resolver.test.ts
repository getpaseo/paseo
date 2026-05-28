import { describe, expect, it, vi } from "vitest";
import {
  classifyForResolution,
  fetchDaemonResolution,
  getAssistantFileLinkToken,
  UnresolvedFileLinkError,
  type AssistantFileLinkContext,
  type DirectorySuggestionEntry,
  type DirectorySuggestionResult,
  type GetDirectorySuggestions,
} from "./resolver";

const CONTEXT: AssistantFileLinkContext = {
  workspaceRoot: "/Users/test/project",
};

function resolvedSuggestions(
  entries: DirectorySuggestionResult["entries"],
): DirectorySuggestionResult {
  return { entries, error: null };
}

function suggestionsFromMap(entriesByQuery: Record<string, DirectorySuggestionEntry[]>): {
  getDirectorySuggestions: GetDirectorySuggestions;
  searches: Array<{
    query: string;
    cwd: string;
    matchMode: "suffix";
    limit: number;
  }>;
} {
  const searches: Array<{
    query: string;
    cwd: string;
    matchMode: "suffix";
    limit: number;
  }> = [];
  const getDirectorySuggestions = vi.fn<GetDirectorySuggestions>(
    async (input: {
      query: string;
      cwd: string;
      includeFiles: true;
      includeDirectories: false;
      matchMode: "suffix";
      limit: number;
    }) => {
      searches.push({
        query: input.query,
        cwd: input.cwd,
        matchMode: input.matchMode,
        limit: input.limit,
      });
      return resolvedSuggestions(entriesByQuery[input.query] ?? []);
    },
  );
  return { getDirectorySuggestions, searches };
}

describe("classifyForResolution", () => {
  it("returns the directFile target synchronously", () => {
    const result = classifyForResolution({ href: "src/components/message.tsx#L33" }, CONTEXT);

    expect(result).toEqual({
      kind: "resolved",
      value: {
        kind: "file",
        target: {
          raw: "src/components/message.tsx#L33",
          path: "/Users/test/project/src/components/message.tsx",
          lineStart: 33,
          lineEnd: undefined,
        },
      },
    });
  });

  it("preserves line ranges on direct workspace files", () => {
    const result = classifyForResolution({ href: "src/components/message.tsx:33-40" }, CONTEXT);

    expect(result).toEqual({
      kind: "resolved",
      value: {
        kind: "file",
        target: {
          raw: "src/components/message.tsx:33-40",
          path: "/Users/test/project/src/components/message.tsx",
          lineStart: 33,
          lineEnd: 40,
        },
      },
    });
  });

  it("flags basename inline-code as a daemon lookup keyed by suggestion query", () => {
    const result = classifyForResolution(
      { href: "file.ts:12", text: "file.ts:12", sourceType: "inline-code" },
      CONTEXT,
    );

    expect(result).toEqual({
      kind: "needsLookup",
      ambiguousQuery: "file.ts",
      token: "file.ts:12",
      target: {
        raw: "file.ts:12",
        path: "/Users/test/project/file.ts",
        lineStart: 12,
        lineEnd: undefined,
      },
    });
  });

  it("keeps explicit external URLs external", () => {
    const result = classifyForResolution({ href: "http://dumm.md", text: "dumm.md" }, CONTEXT);

    expect(result).toEqual({
      kind: "resolved",
      value: { kind: "external", url: "http://dumm.md" },
    });
  });

  it("keeps auto-linkified normal domains external", () => {
    const result = classifyForResolution(
      { href: "http://google.com", text: "google.com", markup: "linkify" },
      CONTEXT,
    );

    expect(result).toEqual({
      kind: "resolved",
      value: { kind: "external", url: "http://google.com" },
    });
  });

  it("returns ignored for non-file-looking content", () => {
    const result = classifyForResolution({ href: "" }, CONTEXT);

    expect(result).toEqual({ kind: "resolved", value: { kind: "ignored" } });
  });
});

describe("fetchDaemonResolution", () => {
  it("resolves daemon suggestions into workspace file targets", async () => {
    const { getDirectorySuggestions, searches } = suggestionsFromMap({
      "file.ts": [{ path: "packages/app/src/file.ts", kind: "file" }],
    });

    const result = await fetchDaemonResolution({
      ambiguousQuery: "file.ts",
      token: "file.ts:12",
      target: {
        raw: "file.ts:12",
        path: "/Users/test/project/file.ts",
        lineStart: 12,
        lineEnd: undefined,
      },
      workspaceRoot: "/Users/test/project",
      getDirectorySuggestions,
    });

    expect(searches).toEqual([
      {
        query: "file.ts",
        cwd: "/Users/test/project",
        matchMode: "suffix",
        limit: 1,
      },
    ]);
    expect(result).toEqual({
      raw: "file.ts:12",
      path: "/Users/test/project/packages/app/src/file.ts",
      lineStart: 12,
      lineEnd: undefined,
    });
  });

  it("throws a typed unresolved error when the daemon finds no match", async () => {
    const { getDirectorySuggestions } = suggestionsFromMap({});

    await expect(
      fetchDaemonResolution({
        ambiguousQuery: "src/file.ts",
        token: "src/file.ts",
        target: {
          raw: "src/file.ts",
          path: "/Users/test/project/src/file.ts",
          lineStart: undefined,
          lineEnd: undefined,
        },
        workspaceRoot: "/Users/test/project",
        getDirectorySuggestions,
      }),
    ).rejects.toEqual(new UnresolvedFileLinkError("src/file.ts"));
  });

  it("throws a typed unresolved error when the daemon throws", async () => {
    const getDirectorySuggestions = vi.fn<GetDirectorySuggestions>(async () => {
      throw new Error("daemon unavailable");
    });

    await expect(
      fetchDaemonResolution({
        ambiguousQuery: "dumm.md",
        token: "dumm.md",
        target: {
          raw: "dumm.md",
          path: "/Users/test/project/dumm.md",
          lineStart: undefined,
          lineEnd: undefined,
        },
        workspaceRoot: "/Users/test/project",
        getDirectorySuggestions,
      }),
    ).rejects.toEqual(new UnresolvedFileLinkError("dumm.md"));
  });
});

describe("getAssistantFileLinkToken", () => {
  it("uses rendered text for markdown-it linkified tokens and href for explicit links", () => {
    expect(
      getAssistantFileLinkToken({
        href: "http://dumm.md",
        text: "dumm.md",
        markup: "linkify",
        sourceInfo: "auto",
      }),
    ).toBe("dumm.md");
    expect(
      getAssistantFileLinkToken({
        href: "http://google.com",
        text: "google.com",
        markup: "linkify",
        sourceInfo: "auto",
      }),
    ).toBe("http://google.com");
    expect(
      getAssistantFileLinkToken({
        href: "http://dumm.md",
        text: "dumm.md",
        markup: "",
        sourceInfo: "",
      }),
    ).toBe("http://dumm.md");
    expect(
      getAssistantFileLinkToken({
        href: "workspace-git-service.ts:1553",
        text: "workspace-git-service.ts:1553",
        sourceType: "inline-code",
      }),
    ).toBe("workspace-git-service.ts:1553");
  });
});

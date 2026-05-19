import { describe, expect, it, vi } from "vitest";
import {
  getAssistantFileLinkToken,
  resolveAssistantFileLink,
  resolveAssistantFileLinkSync,
  type AssistantFileLinkContext,
  type DirectorySuggestionEntry,
  type DirectorySuggestionResult,
} from "./resolver";

const CONTEXT: AssistantFileLinkContext = {
  serverId: "server-1",
  workspaceRoot: "/Users/test/project",
};

function resolvedSuggestions(
  entries: DirectorySuggestionResult["entries"],
): DirectorySuggestionResult {
  return { entries, error: null };
}

function suggestionsFromMap(entriesByQuery: Record<string, DirectorySuggestionEntry[]>): {
  getDirectorySuggestions: ReturnType<typeof vi.fn>;
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
  const getDirectorySuggestions = vi.fn(
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

describe("resolveAssistantFileLink", () => {
  it("resolves a direct workspace file without querying suggestions", async () => {
    const getDirectorySuggestions = vi.fn(async () => resolvedSuggestions([]));

    const result = await resolveAssistantFileLink({
      source: { href: "src/components/message.tsx#L33" },
      context: CONTEXT,
      getDirectorySuggestions,
    });

    expect(getDirectorySuggestions).not.toHaveBeenCalled();
    expect(result).toEqual({
      kind: "file",
      target: {
        raw: "src/components/message.tsx#L33",
        path: "/Users/test/project/src/components/message.tsx",
        lineStart: 33,
        lineEnd: undefined,
      },
    });
  });

  it("preserves line ranges on direct workspace files", async () => {
    const result = await resolveAssistantFileLink({
      source: { href: "src/components/message.tsx:33-40" },
      context: CONTEXT,
      getDirectorySuggestions: vi.fn(async () => resolvedSuggestions([])),
    });

    expect(result).toEqual({
      kind: "file",
      target: {
        raw: "src/components/message.tsx:33-40",
        path: "/Users/test/project/src/components/message.tsx",
        lineStart: 33,
        lineEnd: 40,
      },
    });
  });

  it("resolves a basename inline-code through the daemon", async () => {
    const { getDirectorySuggestions, searches } = suggestionsFromMap({
      "file.ts": [{ path: "packages/app/src/file.ts", kind: "file" }],
    });

    const result = await resolveAssistantFileLink({
      source: { href: "file.ts:12", text: "file.ts:12", sourceType: "inline-code" },
      context: CONTEXT,
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
      kind: "file",
      target: {
        raw: "file.ts:12",
        path: "/Users/test/project/packages/app/src/file.ts",
        lineStart: 12,
        lineEnd: undefined,
      },
    });
  });

  it("returns unresolvedFileCandidate when the daemon finds no match", async () => {
    const { getDirectorySuggestions } = suggestionsFromMap({});

    const result = await resolveAssistantFileLink({
      source: { href: "src/file.ts", text: "src/file.ts", sourceType: "inline-code" },
      context: CONTEXT,
      getDirectorySuggestions,
    });

    expect(result).toEqual({
      kind: "unresolvedFileCandidate",
      token: "src/file.ts",
    });
  });

  it("returns unresolvedFileCandidate when the daemon throws", async () => {
    const result = await resolveAssistantFileLink({
      source: { href: "http://dumm.md", text: "dumm.md", markup: "linkify" },
      context: CONTEXT,
      getDirectorySuggestions: vi.fn(async () => {
        throw new Error("daemon unavailable");
      }),
    });

    expect(result).toEqual({
      kind: "unresolvedFileCandidate",
      token: "dumm.md",
    });
  });

  it("keeps explicit external URLs external", async () => {
    const getDirectorySuggestions = vi.fn(async () => resolvedSuggestions([]));

    const result = await resolveAssistantFileLink({
      source: { href: "http://dumm.md", text: "dumm.md" },
      context: CONTEXT,
      getDirectorySuggestions,
    });

    expect(getDirectorySuggestions).not.toHaveBeenCalled();
    expect(result).toEqual({ kind: "external", url: "http://dumm.md" });
  });

  it("keeps auto-linkified normal domains external", async () => {
    const getDirectorySuggestions = vi.fn(async () => resolvedSuggestions([]));

    const result = await resolveAssistantFileLink({
      source: { href: "http://google.com", text: "google.com", markup: "linkify" },
      context: CONTEXT,
      getDirectorySuggestions,
    });

    expect(getDirectorySuggestions).not.toHaveBeenCalled();
    expect(result).toEqual({ kind: "external", url: "http://google.com" });
  });

  it("returns unresolvedFileCandidate for linkified filenames the daemon can't find", async () => {
    const getDirectorySuggestions = vi.fn(async () => resolvedSuggestions([]));

    const result = await resolveAssistantFileLink({
      source: { href: "http://dumm.md", text: "dumm.md", sourceInfo: "auto" },
      context: CONTEXT,
      getDirectorySuggestions,
    });

    expect(result).toEqual({ kind: "unresolvedFileCandidate", token: "dumm.md" });
  });

  it("returns ignored for non-file-looking content", async () => {
    const result = await resolveAssistantFileLink({
      source: { href: "" },
      context: CONTEXT,
      getDirectorySuggestions: vi.fn(async () => resolvedSuggestions([])),
    });

    expect(result).toEqual({ kind: "ignored" });
  });
});

describe("resolveAssistantFileLinkSync", () => {
  it("returns the directFile target synchronously", () => {
    const result = resolveAssistantFileLinkSync({
      source: { href: "src/components/message.tsx#L33" },
      context: CONTEXT,
    });

    expect(result).toEqual({
      kind: "resolved",
      resolved: {
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

  it("flags ambiguous basenames as needsLookup", () => {
    const result = resolveAssistantFileLinkSync({
      source: { href: "file.ts:12", text: "file.ts:12", sourceType: "inline-code" },
      context: CONTEXT,
    });

    expect(result.kind).toBe("needsLookup");
  });

  it("returns external synchronously", () => {
    const result = resolveAssistantFileLinkSync({
      source: { href: "http://google.com" },
      context: CONTEXT,
    });

    expect(result).toEqual({
      kind: "resolved",
      resolved: { kind: "external", url: "http://google.com" },
    });
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

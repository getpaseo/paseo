import { describe, expect, it } from "vitest";
import {
  isNamedFileSuggestion,
  matchHiddenListingEntries,
  planDaemonFileSearchRequest,
  resolveSuggestedFilePath,
} from "./file-search-query";

describe("planDaemonFileSearchRequest", () => {
  it("leaves workspace-relative queries to the daemon", () => {
    expect(
      planDaemonFileSearchRequest({
        query: "src/components/message.tsx",
        workspaceRoot: "/code/app",
      }),
    ).toBeNull();
    expect(planDaemonFileSearchRequest({ query: "", workspaceRoot: "/code/app" })).toBeNull();
  });

  it("leaves absolute queries inside the workspace to the daemon", () => {
    expect(
      planDaemonFileSearchRequest({
        query: "/code/app/src/index.ts",
        workspaceRoot: "/code/app",
      }),
    ).toBeNull();
    expect(
      planDaemonFileSearchRequest({ query: "/code/app", workspaceRoot: "/code/app" }),
    ).toBeNull();
  });

  it("re-roots an absolute file path onto its own directory", () => {
    expect(
      planDaemonFileSearchRequest({
        query: "/Users/me/.agent/diagrams/plan.html",
        workspaceRoot: "/code/app",
      }),
    ).toEqual({
      list: {
        cwd: "/Users/me/.agent/diagrams",
        query: "plan.html",
        root: "/Users/me/.agent/diagrams",
      },
      exact: {
        cwd: "/Users/me/.agent/diagrams",
        query: "./plan.html",
        root: "/Users/me/.agent/diagrams",
      },
      hiddenListing: null,
      namedPath: "/Users/me/.agent/diagrams/plan.html",
    });
  });

  it("asks for the named path itself, so hidden and Git-ignored names still resolve", () => {
    const plan = planDaemonFileSearchRequest({
      query: "/tmp/private/.env",
      workspaceRoot: "/code/app",
    });
    expect(plan?.exact).toEqual({ cwd: "/tmp/private", query: "./.env", root: "/tmp/private" });
    // Discovery keeps hidden files out of the listing; the named lookup is what surfaces them.
    expect(plan?.list.query).toBe(".env");
    expect(plan?.namedPath).toBe("/tmp/private/.env");
  });

  it("lists the parent directory for a partial hidden name", () => {
    // `~/.zsh` matches neither discovery (hidden) nor retrieval (no such file), so the parent has
    // to be listed. The typed prefix is carried by the listing request's query.
    expect(planDaemonFileSearchRequest({ query: "~/.zsh" })).toEqual({
      list: { cwd: "~", query: ".zsh", root: "~" },
      exact: { cwd: "~", query: "./.zsh", root: "~" },
      hiddenListing: { cwd: "~", query: "", root: "~" },
      namedPath: "~/.zsh",
    });
    expect(
      planDaemonFileSearchRequest({ query: "/tmp/private/.env", workspaceRoot: "/code/app" }),
    ).toMatchObject({ hiddenListing: { cwd: "/tmp/private", query: "", root: "/tmp/private" } });
  });

  it("does not list the parent directory for a visible name", () => {
    expect(
      planDaemonFileSearchRequest({ query: "~/notes/todo.md", workspaceRoot: "/code/app" })
        ?.hiddenListing,
    ).toBeNull();
  });

  it("treats dot segments as segments, not hidden names", () => {
    expect(planDaemonFileSearchRequest({ query: "~/.." })?.hiddenListing).toBeNull();
    expect(planDaemonFileSearchRequest({ query: "~" })?.hiddenListing).toBeNull();
  });

  it("browses the typed directory itself when the query ends with a separator", () => {
    expect(
      planDaemonFileSearchRequest({
        query: "/Users/me/.agent/diagrams/",
        workspaceRoot: "/code/app",
      }),
    ).toEqual({
      list: { cwd: "/Users/me/.agent/diagrams", query: "", root: "/Users/me/.agent/diagrams" },
      exact: null,
      hiddenListing: null,
      namedPath: "/Users/me/.agent/diagrams",
    });
    expect(planDaemonFileSearchRequest({ query: "/", workspaceRoot: "/code/app" })).toEqual({
      list: { cwd: "/", query: "", root: "/" },
      exact: null,
      hiddenListing: null,
      namedPath: "/",
    });
  });

  it("resolves parent segments before deciding where the path lives", () => {
    // `/code/app/../other` starts with the workspace path but leaves it.
    expect(
      planDaemonFileSearchRequest({
        query: "/code/app/../other/plan.md",
        workspaceRoot: "/code/app",
      }),
    ).toEqual({
      list: { cwd: "/code/other", query: "plan.md", root: "/code/other" },
      exact: { cwd: "/code/other", query: "./plan.md", root: "/code/other" },
      hiddenListing: null,
      namedPath: "/code/other/plan.md",
    });
    expect(
      planDaemonFileSearchRequest({
        query: "/code/app/./src/../src/index.ts",
        workspaceRoot: "/code/app",
      }),
    ).toBeNull();
    expect(
      planDaemonFileSearchRequest({ query: "/../tmp/notes.md", workspaceRoot: "/code/app" }),
    ).toEqual({
      list: { cwd: "/tmp", query: "notes.md", root: "/tmp" },
      exact: { cwd: "/tmp", query: "./notes.md", root: "/tmp" },
      hiddenListing: null,
      namedPath: "/tmp/notes.md",
    });
  });

  it("treats a home-relative path as its own root", () => {
    expect(planDaemonFileSearchRequest({ query: "~/.agent/diagrams/plan.html" })).toEqual({
      list: { cwd: "~/.agent/diagrams", query: "plan.html", root: "~/.agent/diagrams" },
      exact: { cwd: "~/.agent/diagrams", query: "./plan.html", root: "~/.agent/diagrams" },
      hiddenListing: null,
      namedPath: "~/.agent/diagrams/plan.html",
    });
    expect(planDaemonFileSearchRequest({ query: "~/", workspaceRoot: "/code/app" })).toEqual({
      list: { cwd: "~", query: "", root: "~" },
      exact: null,
      hiddenListing: null,
      namedPath: "~",
    });
  });

  it("keeps a home-relative path even when the workspace is the home directory", () => {
    expect(
      planDaemonFileSearchRequest({ query: "~/notes/todo.md", workspaceRoot: "/Users/me" }),
    ).toEqual({
      list: { cwd: "~/notes", query: "todo.md", root: "~/notes" },
      exact: { cwd: "~/notes", query: "./todo.md", root: "~/notes" },
      hiddenListing: null,
      namedPath: "~/notes/todo.md",
    });
  });

  it("keeps a home prefix that parent segments cannot pop", () => {
    // `~/../other` is not `other`: the daemon has to expand `~` before walking to the parent.
    expect(
      planDaemonFileSearchRequest({
        query: "~/../other/plan.md",
        workspaceRoot: "/code/app",
      }),
    ).toEqual({
      list: { cwd: "~/../other", query: "plan.md", root: "~/../other" },
      exact: { cwd: "~/../other", query: "./plan.md", root: "~/../other" },
      hiddenListing: null,
      namedPath: "~/../other/plan.md",
    });
    expect(planDaemonFileSearchRequest({ query: "~/foo/../bar" })).toEqual({
      list: { cwd: "~", query: "bar", root: "~" },
      exact: { cwd: "~", query: "./bar", root: "~" },
      hiddenListing: null,
      namedPath: "~/bar",
    });
    expect(planDaemonFileSearchRequest({ query: "~/.." })).toEqual({
      list: { cwd: "~", query: "..", root: "~" },
      exact: { cwd: "~", query: "./..", root: "~" },
      hiddenListing: null,
      namedPath: "~/..",
    });
  });

  it("normalizes Windows separators and keeps a drive root a root", () => {
    expect(
      planDaemonFileSearchRequest({
        query: "C:\\Users\\me\\plan.html",
        workspaceRoot: "C:\\code\\app",
      }),
    ).toEqual({
      list: { cwd: "C:/Users/me", query: "plan.html", root: "C:/Users/me" },
      exact: { cwd: "C:/Users/me", query: "./plan.html", root: "C:/Users/me" },
      hiddenListing: null,
      namedPath: "C:/Users/me/plan.html",
    });
    // `C:` alone means "the current directory on drive C", not the drive root.
    expect(planDaemonFileSearchRequest({ query: "C:/", workspaceRoot: "C:/code/app" })).toEqual({
      list: { cwd: "C:/", query: "", root: "C:/" },
      exact: null,
      hiddenListing: null,
      namedPath: "C:/",
    });
    expect(
      planDaemonFileSearchRequest({ query: "C:/plan.html", workspaceRoot: "C:/code/app" }),
    ).toEqual({
      list: { cwd: "C:/", query: "plan.html", root: "C:/" },
      exact: { cwd: "C:/", query: "./plan.html", root: "C:/" },
      hiddenListing: null,
      namedPath: "C:/plan.html",
    });
  });

  it("re-roots a query with no workspace root to compare against", () => {
    expect(planDaemonFileSearchRequest({ query: "/tmp/notes.md" })).toEqual({
      list: { cwd: "/tmp", query: "notes.md", root: "/tmp" },
      exact: { cwd: "/tmp", query: "./notes.md", root: "/tmp" },
      hiddenListing: null,
      namedPath: "/tmp/notes.md",
    });
  });
});

describe("isNamedFileSuggestion", () => {
  it("accepts the path the user typed", () => {
    expect(
      isNamedFileSuggestion({
        root: "/tmp/private",
        path: ".env",
        namedPath: "/tmp/private/.env",
      }),
    ).toBe(true);
    expect(
      isNamedFileSuggestion({
        root: "~",
        path: "notes/todo.md",
        namedPath: "~/notes/todo.md",
      }),
    ).toBe(true);
    expect(
      isNamedFileSuggestion({
        root: "C:/",
        path: "plan.html",
        namedPath: "c:/plan.html",
      }),
    ).toBe(true);
  });

  it("rejects a same-named file the suffix search found deeper under the root", () => {
    // The typed path does not exist; the suffix fallback offers a different `.env`.
    expect(
      isNamedFileSuggestion({
        root: "/tmp/private",
        path: "deep/.env",
        namedPath: "/tmp/private/.env",
      }),
    ).toBe(false);
    expect(
      isNamedFileSuggestion({
        root: "/tmp/private",
        path: "elsewhere/.env",
        namedPath: "/tmp/private/.env",
      }),
    ).toBe(false);
  });
});

describe("matchHiddenListingEntries", () => {
  const entries = [
    { name: ".zshrc", kind: "file" },
    { name: ".zshenv", kind: "file" },
    { name: ".zsh_history", kind: "file" },
    { name: ".zcompdump", kind: "file" },
    { name: ".zsh", kind: "directory" },
    { name: "notes.md", kind: "file" },
  ];

  it("keeps only the entries that start with the typed prefix", () => {
    expect(
      matchHiddenListingEntries({ entries, typedName: ".zsh", limit: 100 }).map((e) => e.name),
    ).toEqual([".zshrc", ".zshenv", ".zsh_history"]);
  });

  it("ignores directories, so a same-named folder cannot shadow the file", () => {
    expect(
      matchHiddenListingEntries({ entries, typedName: ".zsh", limit: 100 }).some(
        (e) => e.name === ".zsh",
      ),
    ).toBe(false);
  });

  it("respects the limit", () => {
    expect(matchHiddenListingEntries({ entries, typedName: ".zsh", limit: 2 })).toHaveLength(2);
  });

  it("matches case-insensitively", () => {
    expect(
      matchHiddenListingEntries({ entries, typedName: ".ZSH", limit: 100 }).map((e) => e.name),
    ).toEqual([".zshrc", ".zshenv", ".zsh_history"]);
  });

  it("keeps every dotfile for a bare dot", () => {
    expect(
      matchHiddenListingEntries({ entries, typedName: ".", limit: 100 }).map((e) => e.name),
    ).toEqual([".zshrc", ".zshenv", ".zsh_history", ".zcompdump"]);
  });
});

describe("resolveSuggestedFilePath", () => {
  it("re-attaches the search root to a relative suggestion", () => {
    expect(resolveSuggestedFilePath({ root: "/Users/me/.agent/diagrams", path: "plan.html" })).toBe(
      "/Users/me/.agent/diagrams/plan.html",
    );
    expect(resolveSuggestedFilePath({ root: "/", path: "tmp/notes.md" })).toBe("/tmp/notes.md");
    expect(resolveSuggestedFilePath({ root: "~", path: "notes/todo.md" })).toBe("~/notes/todo.md");
    expect(resolveSuggestedFilePath({ root: "C:/", path: "tmp/notes.md" })).toBe("C:/tmp/notes.md");
  });

  it("keeps the root when the suggestion points at the root itself", () => {
    expect(resolveSuggestedFilePath({ root: "/tmp", path: "." })).toBe("/tmp");
    expect(resolveSuggestedFilePath({ root: "/tmp", path: "" })).toBe("/tmp");
  });

  it("normalizes separators in the suggestion", () => {
    expect(resolveSuggestedFilePath({ root: "/tmp", path: "deep\\notes.md" })).toBe(
      "/tmp/deep/notes.md",
    );
  });
});

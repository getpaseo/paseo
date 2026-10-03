import { describe, expect, it } from "vitest";
import {
  isNamedFileSuggestion,
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

  it("browses the typed directory itself when the query ends with a separator", () => {
    expect(
      planDaemonFileSearchRequest({
        query: "/Users/me/.agent/diagrams/",
        workspaceRoot: "/code/app",
      }),
    ).toEqual({
      list: { cwd: "/Users/me/.agent/diagrams", query: "", root: "/Users/me/.agent/diagrams" },
      exact: null,
      namedPath: "/Users/me/.agent/diagrams",
    });
    expect(planDaemonFileSearchRequest({ query: "/", workspaceRoot: "/code/app" })).toEqual({
      list: { cwd: "/", query: "", root: "/" },
      exact: null,
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
      namedPath: "/tmp/notes.md",
    });
  });

  it("treats a home-relative path as its own root", () => {
    expect(planDaemonFileSearchRequest({ query: "~/.agent/diagrams/plan.html" })).toEqual({
      list: { cwd: "~/.agent/diagrams", query: "plan.html", root: "~/.agent/diagrams" },
      exact: { cwd: "~/.agent/diagrams", query: "./plan.html", root: "~/.agent/diagrams" },
      namedPath: "~/.agent/diagrams/plan.html",
    });
    expect(planDaemonFileSearchRequest({ query: "~/", workspaceRoot: "/code/app" })).toEqual({
      list: { cwd: "~", query: "", root: "~" },
      exact: null,
      namedPath: "~",
    });
  });

  it("keeps a home-relative path even when the workspace is the home directory", () => {
    expect(
      planDaemonFileSearchRequest({ query: "~/notes/todo.md", workspaceRoot: "/Users/me" }),
    ).toEqual({
      list: { cwd: "~/notes", query: "todo.md", root: "~/notes" },
      exact: { cwd: "~/notes", query: "./todo.md", root: "~/notes" },
      namedPath: "~/notes/todo.md",
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
      namedPath: "C:/Users/me/plan.html",
    });
    // `C:` alone means "the current directory on drive C", not the drive root.
    expect(planDaemonFileSearchRequest({ query: "C:/", workspaceRoot: "C:/code/app" })).toEqual({
      list: { cwd: "C:/", query: "", root: "C:/" },
      exact: null,
      namedPath: "C:/",
    });
    expect(
      planDaemonFileSearchRequest({ query: "C:/plan.html", workspaceRoot: "C:/code/app" }),
    ).toEqual({
      list: { cwd: "C:/", query: "plan.html", root: "C:/" },
      exact: { cwd: "C:/", query: "./plan.html", root: "C:/" },
      namedPath: "C:/plan.html",
    });
  });

  it("re-roots a query with no workspace root to compare against", () => {
    expect(planDaemonFileSearchRequest({ query: "/tmp/notes.md" })).toEqual({
      list: { cwd: "/tmp", query: "notes.md", root: "/tmp" },
      exact: { cwd: "/tmp", query: "./notes.md", root: "/tmp" },
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

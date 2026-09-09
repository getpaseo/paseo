import { describe, expect, it } from "vitest";
import type { CommandCenterWorkspaceResult } from "./results";
import { filterAndRankWorkspaces } from "./workspace-search";

function workspace(input: {
  id: string;
  title?: string;
  subtitle?: string;
  changeRequestNumber?: number | null;
}): CommandCenterWorkspaceResult {
  return {
    kind: "workspace",
    id: input.id,
    title: input.title ?? input.id,
    subtitle: input.subtitle ?? "",
    changeRequestNumber: input.changeRequestNumber ?? null,
    run: () => undefined,
  };
}

function ids(rows: readonly CommandCenterWorkspaceResult[], query: string): string[] {
  return filterAndRankWorkspaces(rows, query, (left, right) => left.id.localeCompare(right.id)).map(
    (row) => row.id,
  );
}

describe("filterAndRankWorkspaces", () => {
  const subject = workspace({
    id: "payments",
    title: "Payments refactor",
    subtitle: "Primary host · feature/checkout",
    changeRequestNumber: 42,
  });

  it("matches everything when the query is empty", () => {
    expect(ids([subject], "  ")).toEqual(["payments"]);
  });

  it("matches its own change-request number in every spelling", () => {
    const spellings = ["42", " 42 ", "#42", "!42", "pr 42", "mr 42", "PR #42", "mr!42", "pr42"];
    for (const query of spellings) {
      expect(ids([subject], query)).toEqual(["payments"]);
    }
  });

  it("does not take the number path for text that merely contains digits", () => {
    const numbered = workspace({ id: "unrelated workspace", changeRequestNumber: 42 });
    for (const query of ["fix-42-retries", "42x", "v4.2", "pr"]) {
      expect(ids([numbered], query)).toEqual([]);
    }
  });

  it("does not match a different change-request number that shares digits", () => {
    const other = workspace({ id: "unrelated", changeRequestNumber: 142 });
    expect(ids([other], "42")).toEqual([]);
  });

  it("still matches on title and branch text", () => {
    expect(ids([subject], "checkout")).toEqual(["payments"]);
    expect(ids([subject], "payments")).toEqual(["payments"]);
  });

  it("leaves a workspace without a change request unaffected", () => {
    const noPr = workspace({ id: "docs workspace" });
    expect(ids([noPr], "42")).toEqual([]);
    expect(ids([noPr], "docs")).toEqual(["docs workspace"]);
  });

  it("falls back to text matching when the number does not match", () => {
    const textual = workspace({
      id: "text",
      subtitle: "branch fix-42-retries",
      changeRequestNumber: 7,
    });
    expect(ids([textual], "42")).toEqual(["text"]);
  });

  it("ranks an exact change request above an ordinary text match", () => {
    const text = workspace({ id: "a-text", title: "Migration 42" });
    expect(ids([text, subject], "42")).toEqual(["payments", "a-text"]);
  });
});

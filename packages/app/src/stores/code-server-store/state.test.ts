import { describe, expect, test } from "vitest";
import {
  type CodeServerRecord,
  createCodeServerRecord,
  getNextCodeServerTitle,
  renameCodeServerInIndex,
} from "./state";

function record(id: string, title: string): CodeServerRecord {
  return {
    codeServerId: id,
    browserId: `browser-${id}`,
    initialUrl: "http://127.0.0.1:13337",
    title,
    createdAt: 0,
  };
}

describe("code server store state", () => {
  test("assigns the next deterministic Code Server title", () => {
    expect(
      getNextCodeServerTitle({
        a: record("a", "Code Server 1"),
        b: record("b", "Renamed editor"),
        c: record("c", "Code Server 3"),
      }),
    ).toBe("Code Server 4");
  });

  test("scopes default title numbering to a workspace key", () => {
    expect(
      getNextCodeServerTitle(
        {
          a: { ...record("a", "Code Server 1"), workspaceKey: "ws-a" },
          b: { ...record("b", "Code Server 7"), workspaceKey: "ws-b" },
          c: { ...record("c", "Code Server 2"), workspaceKey: "ws-a" },
          d: record("d", "Code Server 9"),
        },
        "ws-a",
      ),
    ).toBe("Code Server 3");
    expect(
      getNextCodeServerTitle(
        {
          a: { ...record("a", "Code Server 1"), workspaceKey: "ws-a" },
          b: { ...record("b", "Code Server 7"), workspaceKey: "ws-b" },
        },
        "ws-b",
      ),
    ).toBe("Code Server 8");
  });

  test("normalizes localhost-style initial URLs", () => {
    expect(
      createCodeServerRecord({
        codeServerId: "code-1",
        browserId: "browser-1",
        initialUrl: "127.0.0.1:13337",
        title: "Code Server 1",
        now: 0,
      }).initialUrl,
    ).toBe("http://127.0.0.1:13337");
  });

  test("renames code server records locally", () => {
    const next = renameCodeServerInIndex(
      { codeServersById: { a: record("a", "Code Server 1") } },
      "a",
      "Project editor",
    );

    expect(next.codeServersById.a?.title).toBe("Project editor");
  });
});

import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { URI } from "vscode-uri";
import {
  PathOutsideWorkspaceError,
  resolvePathWithinRoot,
  toDefinitionResult,
} from "./definition-mapping.js";

const ROOT = "/workspace/project";

function link(absolutePath: string) {
  const range = { start: { line: 3, character: 0 }, end: { line: 5, character: 1 } };
  return {
    targetUri: URI.file(absolutePath).toString(),
    targetRange: range,
    targetSelectionRange: { start: { line: 3, character: 9 }, end: { line: 3, character: 20 } },
    originSelectionRange: { start: { line: 1, character: 9 }, end: { line: 1, character: 23 } },
  };
}

describe("resolvePathWithinRoot", () => {
  it("resolves a relative path against the root", () => {
    expect(resolvePathWithinRoot(ROOT, "src/app.ts")).toBe(resolve(ROOT, "src/app.ts"));
  });

  it("rejects traversal out of the workspace", () => {
    expect(() => resolvePathWithinRoot(ROOT, "../secrets.txt")).toThrow(PathOutsideWorkspaceError);
    expect(() => resolvePathWithinRoot(ROOT, "src/../../secrets.txt")).toThrow(
      PathOutsideWorkspaceError,
    );
  });

  it("rejects an absolute path pointing elsewhere", () => {
    expect(() => resolvePathWithinRoot(ROOT, "/etc/passwd")).toThrow(PathOutsideWorkspaceError);
  });
});

describe("toDefinitionResult", () => {
  it("returns workspace-relative targets and keeps the origin range", () => {
    const result = toDefinitionResult(ROOT, {
      status: "ok",
      links: [link(`${ROOT}/src/screens/sessions-screen.tsx`)],
    });

    expect(result).toEqual({
      status: "ok",
      targets: [
        {
          path: "src/screens/sessions-screen.tsx",
          range: { start: { line: 3, character: 0 }, end: { line: 5, character: 1 } },
          selectionRange: {
            start: { line: 3, character: 9 },
            end: { line: 3, character: 20 },
          },
          originRange: { start: { line: 1, character: 9 }, end: { line: 1, character: 23 } },
        },
      ],
    });
  });

  it("drops targets outside the workspace instead of leaking their paths", () => {
    const result = toDefinitionResult(ROOT, {
      status: "ok",
      links: [link("/usr/lib/node_modules/react/index.d.ts"), link(`${ROOT}/src/app.ts`)],
    });

    expect(result).toEqual({
      status: "ok",
      targets: [expect.objectContaining({ path: "src/app.ts" })],
    });
  });

  it("passes the absent-server state through for the client to act on", () => {
    expect(
      toDefinitionResult(ROOT, {
        status: "server-not-installed",
        serverId: "go",
        command: "gopls",
      }),
    ).toEqual({ status: "server_not_installed", serverId: "go", command: "gopls" });

    expect(toDefinitionResult(ROOT, { status: "unsupported-language" })).toEqual({
      status: "unsupported_language",
    });
  });
});

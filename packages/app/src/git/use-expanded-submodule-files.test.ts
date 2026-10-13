import { describe, expect, it } from "vitest";
import type { ParsedDiffFile } from "@getpaseo/protocol/messages";
import {
  mergeExpandedSubmoduleFiles,
  prefixSubmoduleNestedFile,
  prefixSubmoduleNestedPath,
} from "./use-expanded-submodule-files";

function file(partial: Partial<ParsedDiffFile> & Pick<ParsedDiffFile, "path">): ParsedDiffFile {
  return {
    isNew: false,
    isDeleted: false,
    additions: 0,
    deletions: 0,
    hunks: [],
    ...partial,
  };
}

describe("prefixSubmoduleNestedPath", () => {
  it("joins submodule and nested paths with a slash", () => {
    expect(prefixSubmoduleNestedPath("libs/sub", "nested.txt")).toBe("libs/sub/nested.txt");
    expect(prefixSubmoduleNestedPath("libs/sub", "")).toBe("libs/sub");
  });
});

describe("prefixSubmoduleNestedFile", () => {
  it("prefixes path and oldPath", () => {
    expect(
      prefixSubmoduleNestedFile(
        "libs/sub",
        file({ path: "src/a.ts", oldPath: "src/b.ts", additions: 1 }),
      ),
    ).toEqual(
      file({
        path: "libs/sub/src/a.ts",
        oldPath: "libs/sub/src/b.ts",
        additions: 1,
      }),
    );
  });
});

describe("mergeExpandedSubmoduleFiles", () => {
  it("keeps collapsed submodule stubs without nested files", () => {
    const stub = file({
      path: "libs/sub",
      isSubmodule: true,
      submodule: { oldCommit: "aaa", newCommit: "bbb" },
    });
    const sibling = file({ path: "readme.md", additions: 2 });

    expect(mergeExpandedSubmoduleFiles([stub, sibling], new Map())).toEqual([stub, sibling]);
  });

  it("keeps the stub then appends path-prefixed nested files when expanded", () => {
    const stub = file({
      path: "libs/sub",
      isSubmodule: true,
      submodule: { oldCommit: "aaa", newCommit: "bbb", isDirty: true },
    });
    const nested = file({
      path: "nested.txt",
      isNew: false,
      additions: 1,
      hunks: [
        {
          oldStart: 1,
          oldCount: 1,
          newStart: 1,
          newCount: 2,
          lines: [{ type: "add", content: "changed" }],
        },
      ],
    });

    expect(
      mergeExpandedSubmoduleFiles([stub], new Map([["libs/sub", [nested]]])),
    ).toEqual([
      stub,
      file({
        path: "libs/sub/nested.txt",
        additions: 1,
        hunks: nested.hunks,
      }),
    ]);
  });

  it("does not invent isSubmodule on regular nested files", () => {
    const stub = file({
      path: "libs/sub",
      isSubmodule: true,
      submodule: { oldCommit: null, newCommit: null },
    });
    const nested = file({ path: "extra.txt", isNew: true, additions: 1 });
    const [_, mergedNested] = mergeExpandedSubmoduleFiles(
      [stub],
      new Map([["libs/sub", [nested]]]),
    );
    expect(mergedNested?.isSubmodule).toBeUndefined();
    expect(mergedNested?.path).toBe("libs/sub/extra.txt");
  });
});

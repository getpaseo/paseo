import { sep } from "node:path";
import { expect, test } from "vitest";
import { toWorkspaceRelativePath } from "./path-utils.js";

// Workspace-relative identities cross the wire with "/" whatever the host separator is, so a
// client never has to guess which backslash was a separator and which was a file name character.
test("renders a host-relative path with forward slashes", () => {
  expect(toWorkspaceRelativePath(["src", "app.ts"].join(sep))).toBe("src/app.ts");
  expect(toWorkspaceRelativePath("app.ts")).toBe("app.ts");
});

test.skipIf(sep === "\\")("leaves a POSIX file name containing a backslash intact", () => {
  expect(toWorkspaceRelativePath("a\\b.txt")).toBe("a\\b.txt");
});

test.skipIf(sep !== "\\")("converts every Windows separator", () => {
  expect(toWorkspaceRelativePath("src\\nested\\app.ts")).toBe("src/nested/app.ts");
});

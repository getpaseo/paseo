import { describe, expect, it } from "vitest";
import { getExplorerEntryName, getExplorerParentPath, joinExplorerPath } from "./paths";

describe("file explorer paths", () => {
  it("resolves parent path for nested and root entries", () => {
    expect(getExplorerParentPath("src/app.ts")).toBe("src");
    expect(getExplorerParentPath("app.ts")).toBe(".");
    expect(getExplorerParentPath(".")).toBe(".");
  });

  it("joins parent and name", () => {
    expect(joinExplorerPath(".", "readme.md")).toBe("readme.md");
    expect(joinExplorerPath("src", "app.ts")).toBe("src/app.ts");
  });

  it("reads the entry name", () => {
    expect(getExplorerEntryName("src/app.ts")).toBe("app.ts");
    expect(getExplorerEntryName(".")).toBe("");
  });
});

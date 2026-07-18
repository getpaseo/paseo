import { describe, expect, it } from "vitest";
import { getExplorerParentPath } from "./paths";

describe("file explorer paths", () => {
  it("resolves parent path for nested and root entries", () => {
    expect(getExplorerParentPath("src/app.ts")).toBe("src");
    expect(getExplorerParentPath("app.ts")).toBe(".");
    expect(getExplorerParentPath(".")).toBe(".");
  });
});

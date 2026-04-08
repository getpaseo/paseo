import { describe, expect, it } from "vitest";
import { resolvePreferredEditorId } from "./use-preferred-editor";

describe("resolvePreferredEditorId", () => {
  it("keeps the stored editor when it is still available", () => {
    expect(resolvePreferredEditorId(["cursor", "vscode"], "vscode")).toBe("vscode");
  });

  it("falls back to the first available editor when the stored one is missing", () => {
    expect(resolvePreferredEditorId(["zed", "finder"], "cursor")).toBe("zed");
  });

  it("falls back when a platform-specific file manager target is unavailable", () => {
    expect(resolvePreferredEditorId(["explorer", "vscode"], "finder")).toBe("explorer");
  });

  it("returns null when no editors are available", () => {
    expect(resolvePreferredEditorId([], "cursor")).toBeNull();
  });
});

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

  it("keeps unknown editor ids when they are still available", () => {
    expect(resolvePreferredEditorId(["unknown-editor", "cursor"], "unknown-editor")).toBe(
      "unknown-editor",
    );
  });

  it("keeps custom script target ids as plain strings", () => {
    expect(resolvePreferredEditorId(["script:open-in-nvim", "cursor"], "script:open-in-nvim")).toBe(
      "script:open-in-nvim",
    );
  });

  it("returns null when no editors are available", () => {
    expect(resolvePreferredEditorId([], "cursor")).toBeNull();
  });
});

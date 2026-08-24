import { describe, expect, it } from "vitest";
import { WORKSPACE_FILE_DRAG_MIME } from "@/attachments/workspace-file-drag";
import { classifyDragTypes, readDroppedText } from "./data-transfer";

function dropOf(entries: Record<string, string>) {
  return { getData: (type: string) => entries[type] ?? "" };
}

describe("classifyDragTypes", () => {
  it("accepts a plain-text drag as a text drag when the sink takes text", () => {
    expect(
      classifyDragTypes(["text/plain"], { acceptsWorkspaceFile: false, acceptsText: true }),
    ).toEqual({ isAccepted: true, isTextDrag: true });
  });

  it("keeps a Finder drag a file drag even though it also carries text", () => {
    expect(
      classifyDragTypes(["Files", "text/plain", "text/uri-list"], {
        acceptsWorkspaceFile: false,
        acceptsText: true,
      }),
    ).toEqual({ isAccepted: true, isTextDrag: false });
  });

  it("rejects a text drag when the sink does not take text", () => {
    expect(
      classifyDragTypes(["text/plain", "text/uri-list"], {
        acceptsWorkspaceFile: true,
        acceptsText: false,
      }),
    ).toEqual({ isAccepted: false, isTextDrag: true });
  });

  it("accepts a workspace-file drag only when the sink takes workspace files", () => {
    const types = [WORKSPACE_FILE_DRAG_MIME, "text/plain"];

    expect(classifyDragTypes(types, { acceptsWorkspaceFile: true, acceptsText: false })).toEqual({
      isAccepted: true,
      isTextDrag: false,
    });
    expect(classifyDragTypes(types, { acceptsWorkspaceFile: false, acceptsText: false })).toEqual({
      isAccepted: false,
      isTextDrag: false,
    });
  });
});

describe("readDroppedText", () => {
  it("reads plain text and drops the trailing newline the source appends", () => {
    expect(readDroppedText(dropOf({ "text/plain": "review  the plan\n" }))).toBe(
      "review  the plan",
    );
  });

  it("falls back to the first non-comment line of a uri-list", () => {
    expect(
      readDroppedText(
        dropOf({
          "text/plain": "",
          "text/uri-list":
            "# comment\r\nobsidian://open?vault=notes\r\nhttps://example.com/second\r\n",
        }),
      ),
    ).toBe("obsidian://open?vault=notes");
  });

  it("reports no text when the drop carries none", () => {
    expect(readDroppedText(dropOf({ "text/plain": "\n" }))).toBe(null);
    expect(readDroppedText(dropOf({}))).toBe(null);
  });
});

import { describe, expect, test } from "vitest";
import { createPiExtensionHost } from "../index.js";

describe("pi-ask-user adapter", () => {
  test("combines selection and comment, then answers the follow-up dialog", () => {
    const host = createPiExtensionHost();
    host.onToolStart({
      callId: "ask-1",
      toolName: "ask_user",
      args: { allowComment: true, allowFreeform: false },
      status: "running",
      result: null,
    });
    const mapped = host.mapDialog(
      {
        type: "extension_ui_request",
        id: "select-1",
        method: "select",
        title: "Pick one",
        options: ["A", "B"],
      },
      "pi",
    );
    expect(mapped?.type).toBe("permission");
    if (mapped?.type !== "permission") throw new Error("Expected a combined permission");
    expect(mapped.request.input?.questions).toHaveLength(2);
    expect(
      host.respondToPermission(mapped.request, {
        behavior: "allow",
        updatedInput: { answers: { Response: "B", Comment: "Looks good" } },
      }),
    ).toEqual({ responses: [{ id: "select-1", response: { value: "B" } }] });
    expect(
      host.mapDialog(
        {
          type: "extension_ui_request",
          id: "comment-1",
          method: "input",
          placeholder: "Optional comment (press Enter to skip)...",
        },
        "pi",
      ),
    ).toEqual({ type: "response", response: { value: "Looks good" } });
  });

  test("declines unrelated dialogs and cancels denied selection", () => {
    const host = createPiExtensionHost();
    expect(
      host.mapDialog(
        { type: "extension_ui_request", id: "other", method: "select", options: ["A"] },
        "pi",
      ),
    ).toBeUndefined();
    host.onToolStart({
      callId: "ask-2",
      toolName: "ask_user",
      args: { allowComment: true },
      status: "running",
      result: null,
    });
    const mapped = host.mapDialog(
      { type: "extension_ui_request", id: "select-2", method: "select", options: ["A"] },
      "pi",
    );
    if (mapped?.type !== "permission") throw new Error("Expected a combined permission");
    expect(host.respondToPermission(mapped.request, { behavior: "deny" })).toEqual({
      responses: [{ id: "select-2", response: { cancelled: true } }],
    });
  });
});

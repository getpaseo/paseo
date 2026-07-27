import { describe, expect, it } from "vitest";
import { computeSendableContent } from "./sendable-content";

describe("computeSendableContent", () => {
  it("always shows the send button when visibility is always", () => {
    expect(
      computeSendableContent({
        value: "",
        attachments: [],
        hasExternalContent: false,
        allowEmptySubmit: false,
        isSubmitLoading: false,
        sendButtonVisibility: "always",
      }),
    ).toMatchObject({
      canSubmitContent: false,
      shouldShowSendButton: true,
    });
  });

  it("hides the send button until there is content when visibility is whenContent", () => {
    expect(
      computeSendableContent({
        value: "",
        attachments: [],
        hasExternalContent: false,
        allowEmptySubmit: false,
        isSubmitLoading: false,
        sendButtonVisibility: "whenContent",
      }).shouldShowSendButton,
    ).toBe(false);

    expect(
      computeSendableContent({
        value: "hello",
        attachments: [],
        hasExternalContent: false,
        allowEmptySubmit: false,
        isSubmitLoading: false,
        sendButtonVisibility: "whenContent",
      }),
    ).toMatchObject({
      canSubmitContent: true,
      shouldShowSendButton: true,
    });
  });
});

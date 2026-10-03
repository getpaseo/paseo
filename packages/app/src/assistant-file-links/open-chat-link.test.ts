import { describe, expect, it, vi } from "vitest";
import {
  openChatLink,
  resolveChatLinkDialogChoice,
  type ChatLinkAskResult,
  type OpenChatLinkInput,
} from "./open-chat-link";

function createInput(
  behavior: OpenChatLinkInput["behavior"],
  askHowToOpen = vi.fn<() => Promise<ChatLinkAskResult>>(async () => "internal-tab"),
) {
  return {
    input: {
      url: "https://example.com/docs",
      behavior,
      askHowToOpen,
      openInternal: vi.fn<OpenChatLinkInput["openInternal"]>(),
      openExternal: vi.fn<OpenChatLinkInput["openExternal"]>(async () => undefined),
    },
    askHowToOpen,
  };
}

describe("openChatLink", () => {
  it("opens a link in an internal browser tab", async () => {
    const { input, askHowToOpen } = createInput("internal-tab");

    await openChatLink(input);

    expect(input.openInternal).toHaveBeenCalledWith("https://example.com/docs", "tab");
    expect(input.openExternal).not.toHaveBeenCalled();
    expect(askHowToOpen).not.toHaveBeenCalled();
  });

  it("opens a link in the internal browser on the side", async () => {
    const { input, askHowToOpen } = createInput("internal-side");

    await openChatLink(input);

    expect(input.openInternal).toHaveBeenCalledWith("https://example.com/docs", "side");
    expect(input.openExternal).not.toHaveBeenCalled();
    expect(askHowToOpen).not.toHaveBeenCalled();
  });

  it("opens a link in the external browser", async () => {
    const { input, askHowToOpen } = createInput("external");

    await openChatLink(input);

    expect(input.openExternal).toHaveBeenCalledWith("https://example.com/docs");
    expect(input.openInternal).not.toHaveBeenCalled();
    expect(askHowToOpen).not.toHaveBeenCalled();
  });

  it("asks before choosing an internal browser tab", async () => {
    const { input, askHowToOpen } = createInput("ask");

    await openChatLink(input);

    expect(askHowToOpen).toHaveBeenCalledOnce();
    expect(input.openInternal).toHaveBeenCalledWith("https://example.com/docs", "tab");
    expect(input.openExternal).not.toHaveBeenCalled();
  });

  it("asks before choosing the external browser", async () => {
    const askHowToOpen = vi.fn<() => Promise<ChatLinkAskResult>>(async () => "external");
    const { input } = createInput("ask", askHowToOpen);

    await openChatLink(input);

    expect(askHowToOpen).toHaveBeenCalledOnce();
    expect(input.openExternal).toHaveBeenCalledWith("https://example.com/docs");
    expect(input.openInternal).not.toHaveBeenCalled();
  });

  it("does nothing when the Ask dialog is dismissed", async () => {
    const askHowToOpen = vi.fn<() => Promise<ChatLinkAskResult>>(async () => null);
    const { input } = createInput("ask", askHowToOpen);

    await openChatLink(input);

    expect(askHowToOpen).toHaveBeenCalledOnce();
    expect(input.openExternal).not.toHaveBeenCalled();
    expect(input.openInternal).not.toHaveBeenCalled();
  });
});

describe("resolveChatLinkDialogChoice", () => {
  it("maps explicit dialog buttons and leaves dismissal empty", () => {
    expect(resolveChatLinkDialogChoice(null)).toBeNull();
    expect(resolveChatLinkDialogChoice(0)).toBeNull();
    expect(resolveChatLinkDialogChoice(1)).toBe("external");
    expect(resolveChatLinkDialogChoice(2)).toBe("internal-tab");
  });
});

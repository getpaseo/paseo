import { describe, expect, it, vi } from "vitest";
import { openChatLink, type OpenChatLinkInput } from "./open-chat-link";

function createInput(
  behavior: OpenChatLinkInput["behavior"],
  askToOpenInternal = vi.fn(async () => true),
) {
  return {
    input: {
      url: "https://example.com/docs",
      behavior,
      askToOpenInternal,
      openInternal: vi.fn<OpenChatLinkInput["openInternal"]>(),
      openExternal: vi.fn<OpenChatLinkInput["openExternal"]>(async () => undefined),
    },
    askToOpenInternal,
  };
}

describe("openChatLink", () => {
  it("opens a link in an internal browser tab", async () => {
    const { input, askToOpenInternal } = createInput("internal-tab");

    await openChatLink(input);

    expect(input.openInternal).toHaveBeenCalledWith("https://example.com/docs", "tab");
    expect(input.openExternal).not.toHaveBeenCalled();
    expect(askToOpenInternal).not.toHaveBeenCalled();
  });

  it("opens a link in the internal browser on the side", async () => {
    const { input, askToOpenInternal } = createInput("internal-side");

    await openChatLink(input);

    expect(input.openInternal).toHaveBeenCalledWith("https://example.com/docs", "side");
    expect(input.openExternal).not.toHaveBeenCalled();
    expect(askToOpenInternal).not.toHaveBeenCalled();
  });

  it("opens a link in the external browser", async () => {
    const { input, askToOpenInternal } = createInput("external");

    await openChatLink(input);

    expect(input.openExternal).toHaveBeenCalledWith("https://example.com/docs");
    expect(input.openInternal).not.toHaveBeenCalled();
    expect(askToOpenInternal).not.toHaveBeenCalled();
  });

  it("asks before choosing an internal browser tab", async () => {
    const { input, askToOpenInternal } = createInput("ask");

    await openChatLink(input);

    expect(askToOpenInternal).toHaveBeenCalledOnce();
    expect(input.openInternal).toHaveBeenCalledWith("https://example.com/docs", "tab");
    expect(input.openExternal).not.toHaveBeenCalled();
  });

  it("asks before choosing the external browser", async () => {
    const askToOpenInternal = vi.fn(async () => false);
    const { input } = createInput("ask", askToOpenInternal);

    await openChatLink(input);

    expect(askToOpenInternal).toHaveBeenCalledOnce();
    expect(input.openExternal).toHaveBeenCalledWith("https://example.com/docs");
    expect(input.openInternal).not.toHaveBeenCalled();
  });
});

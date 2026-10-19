import { describe, expect, it } from "vitest";
import { openChatUrl } from "./open-chat-url";

function createOpeners() {
  const opened: { destination: "in-app" | "external"; url: string }[] = [];
  return {
    opened,
    async openInBrowser(url: string) {
      opened.push({ destination: "in-app", url });
    },
    async openExternal(url: string) {
      opened.push({ destination: "external", url });
    },
  };
}

const webUrl = "https://example.com/guide?q=chat#links";

describe("openChatUrl", () => {
  it.each(["external", "in-app"] as const)(
    "opens once in the selected %s destination",
    async (behavior) => {
      const openers = createOpeners();
      await openChatUrl(webUrl, { behavior, ...openers });
      expect(openers.opened).toEqual([{ destination: behavior, url: webUrl }]);
    },
  );

  it("uses the external opener when the client cannot open a workspace browser", async () => {
    const openers = createOpeners();
    await openChatUrl(webUrl, {
      behavior: "in-app",
      openInBrowser: undefined,
      openExternal: openers.openExternal,
    });
    expect(openers.opened).toEqual([{ destination: "external", url: webUrl }]);
  });

  it.each([
    "file:///tmp/readme.md",
    "javascript:alert(1)",
    "data:text/html,hello",
    "mailto:hello@example.com",
    "./guide.md",
    "https://",
  ])("ignores unsupported URL %s before either opener", async (url) => {
    const openers = createOpeners();
    await openChatUrl(url, { behavior: "in-app", ...openers });
    await openChatUrl(url, { behavior: "external", ...openers });
    expect(openers.opened).toEqual([]);
  });

  it("propagates a failed internal open without opening another browser", async () => {
    const openers = createOpeners();
    const failure = new Error("Browser creation failed");
    await expect(
      openChatUrl(webUrl, {
        behavior: "in-app",
        openInBrowser: async () => {
          throw failure;
        },
        openExternal: openers.openExternal,
      }),
    ).rejects.toBe(failure);
    expect(openers.opened).toEqual([]);
  });
});

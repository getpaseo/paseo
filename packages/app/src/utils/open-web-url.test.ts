import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/constants/platform", () => ({ isWeb: true, getIsElectron: () => true }));
vi.mock("@/workspace-tabs/browser", () => ({ openWorkspaceBrowser: vi.fn(() => ({ ok: true })) }));
vi.mock("@/utils/open-external-url", () => ({ openExternalUrl: vi.fn(async () => {}) }));
import { openWorkspaceBrowser } from "@/workspace-tabs/browser";
import { openExternalUrl } from "@/utils/open-external-url";
import { openWebUrl } from "./open-web-url";

describe("workspace web link routing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("window", { location: { pathname: "/h/host/workspace/work" } });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("opens an ordinary click inside the current workspace", async () => {
    await openWebUrl("https://example.com/page");
    expect(openWorkspaceBrowser).toHaveBeenCalledWith({
      workspaceKey: "host:work",
      url: "https://example.com/page",
      intent: "reveal",
    });
    expect(openExternalUrl).not.toHaveBeenCalled();
  });
  it.each([{ metaKey: true }, { nativeEvent: { metaKey: true } }])(
    "captures Command from the click",
    async (event) => {
      await openWebUrl("https://example.com/page", event);
      expect(openExternalUrl).toHaveBeenCalledWith("https://example.com/page");
      expect(openWorkspaceBrowser).not.toHaveBeenCalled();
    },
  );
  it("uses the system browser outside a workspace even after a workspace was open", async () => {
    window.location.pathname = "/settings";
    await openWebUrl("https://example.com/page");
    expect(openExternalUrl).toHaveBeenCalledWith("https://example.com/page");
    expect(openWorkspaceBrowser).not.toHaveBeenCalled();
  });
  it.each(["file:///tmp/test", "/h/host", "javascript:alert(1)"])(
    "preserves non HTTP routing: %s",
    async (url) => {
      await openWebUrl(url);
      expect(openExternalUrl).not.toHaveBeenCalled();
      expect(openWorkspaceBrowser).not.toHaveBeenCalled();
    },
  );
});

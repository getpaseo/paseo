import { describe, expect, it } from "vitest";
import { dispatchWebUrl } from "./dispatch-web-url";

const webUrl = "https://example.com/guide";

function createOpener() {
  const opened: string[] = [];
  return {
    opened,
    open: async (url: string) => {
      opened.push(url);
    },
  };
}

describe("dispatchWebUrl", () => {
  it("dispatches to the captured workspace opener exactly once", async () => {
    const source = createOpener();
    const external = createOpener();
    const captured = { serverId: "host", workspaceRoot: "/repo", onOpenWebUrl: source.open };
    await dispatchWebUrl({ url: webUrl, captured, current: captured, openExternal: external.open });
    expect(source.opened).toEqual([webUrl]);
    expect(external.opened).toEqual([]);
  });

  it("keeps non-chat Markdown external without a workspace capability", async () => {
    const external = createOpener();
    await dispatchWebUrl({ url: webUrl, captured: {}, current: {}, openExternal: external.open });
    expect(external.opened).toEqual([webUrl]);
  });

  it("cancels a stale open when a same-root workspace has a different opener", async () => {
    const source = createOpener();
    const next = createOpener();
    const external = createOpener();
    const captured = { serverId: "host", workspaceRoot: "/repo", onOpenWebUrl: source.open };
    const current = { ...captured, onOpenWebUrl: next.open };
    await dispatchWebUrl({ url: webUrl, captured, current, openExternal: external.open });
    expect(source.opened).toEqual([]);
    expect(next.opened).toEqual([]);
    expect(external.opened).toEqual([]);
  });

  it.each([{ serverId: "other-host" }, { workspaceRoot: "/other-repo" }])(
    "cancels a changed source context %j",
    async (changed) => {
      const source = createOpener();
      const external = createOpener();
      const captured = { serverId: "host", workspaceRoot: "/repo", onOpenWebUrl: source.open };
      await dispatchWebUrl({
        url: webUrl,
        captured,
        current: { ...captured, ...changed },
        openExternal: external.open,
      });
      expect(source.opened).toEqual([]);
      expect(external.opened).toEqual([]);
    },
  );
});

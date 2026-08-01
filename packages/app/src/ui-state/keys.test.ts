import { describe, expect, it } from "vitest";
import { clientReviewKeyToWireKey, toWireComposerKey, toWireReviewKey } from "./keys";

describe("toWireComposerKey", () => {
  it("maps agent keys", () => {
    expect(toWireComposerKey("agent:srv1:agt_9")).toBe("agent:agt_9");
  });

  it("maps draft keys", () => {
    expect(toWireComposerKey("draft:srv1:draft_1")).toBe("draft:draft_1");
  });

  it("maps new-workspace keys", () => {
    expect(toWireComposerKey("new-workspace")).toBe("new-workspace");
    expect(toWireComposerKey("new-workspace:draft:draft_1")).toBe("new-workspace:draft:draft_1");
  });

  it("drops legacy new-workspace path keys", () => {
    expect(toWireComposerKey("new-workspace:srv1:/repo/path")).toBeNull();
  });

  it("rejects empty", () => {
    expect(toWireComposerKey("")).toBeNull();
    expect(toWireComposerKey("   ")).toBeNull();
  });
});

describe("toWireReviewKey", () => {
  it("prefers workspaceId", () => {
    expect(
      toWireReviewKey({
        workspaceId: "ws1",
        cwd: "/tmp/x",
        mode: "working",
        baseRef: "main",
        ignoreWhitespace: false,
      }),
    ).toBe("review:workspace=ws1:mode=working:base=main:ignoreWhitespace=false");
  });
});

describe("clientReviewKeyToWireKey", () => {
  it("strips server segment", () => {
    expect(
      clientReviewKeyToWireKey(
        "review:server=srv1:workspace=ws1:mode=working:base=main:ignoreWhitespace=false",
      ),
    ).toBe("review:workspace=ws1:mode=working:base=main:ignoreWhitespace=false");
  });
});

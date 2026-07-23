import { describe, expect, it } from "vitest";
import { resolveOfferLinkNavigationRoute } from "./offer-link-navigation";

describe("resolveOfferLinkNavigationRoute", () => {
  it("enters through the paired host so startup can restore its remembered workspace", () => {
    expect(resolveOfferLinkNavigationRoute({ serverId: "server-saved" })).toBe("/h/server-saved");
  });

  it("rejects a missing server id", () => {
    expect(resolveOfferLinkNavigationRoute({})).toBeNull();
  });

  it("rejects a non-string server id", () => {
    expect(resolveOfferLinkNavigationRoute({ serverId: 42 })).toBeNull();
  });
});

import { describe, expect, it } from "vitest";
import { canManageWorkspaceLaunches } from "./workspace-launches-capability";

describe("canManageWorkspaceLaunches", () => {
  it("keeps launch controls hidden for an old daemon", () => {
    expect(
      canManageWorkspaceLaunches({
        daemonAdvertisesSupport: false,
        launchDescriptor: undefined,
      }),
    ).toBe(false);
  });

  it("uses an explicit launch descriptor when server info is stale", () => {
    expect(
      canManageWorkspaceLaunches({
        daemonAdvertisesSupport: false,
        launchDescriptor: [],
      }),
    ).toBe(true);
  });
});

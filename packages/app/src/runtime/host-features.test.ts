import { describe, expect, it } from "vitest";
import { hostFeatureAvailability } from "./host-features";

describe("hostFeatureAvailability", () => {
  it("distinguishes an unknown handshake from an unsupported feature", () => {
    expect(hostFeatureAvailability(null, "workspaceOrganization")).toBe("unknown");
    expect(
      hostFeatureAvailability(
        {
          serverId: "server-1",
          hostname: "host",
          version: "old",
          features: {},
        },
        "workspaceOrganization",
      ),
    ).toBe("unsupported");
  });

  it("recognizes advertised features", () => {
    expect(
      hostFeatureAvailability(
        {
          serverId: "server-1",
          hostname: "host",
          version: "new",
          features: { workspaceOrganization: true },
        },
        "workspaceOrganization",
      ),
    ).toBe("supported");
  });
});

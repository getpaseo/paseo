import { describe, expect, test } from "vitest";
import { isPluginSecurityRequestAllowed } from "./authority.js";

describe("plugin security authority lattice", () => {
  const ceiling = {
    filesystem: "workspace",
    network: "restricted",
    approvals: "interactive",
    unattended: "forbidden",
  } as const;

  test("allows only requests at or below each known ceiling", () => {
    expect(
      isPluginSecurityRequestAllowed(ceiling, {
        filesystem: "workspace",
        network: "none",
        approvals: "none",
        unattended: "forbidden",
      }),
    ).toBe(true);
    expect(isPluginSecurityRequestAllowed(ceiling, { filesystem: "unrestricted" })).toBe(false);
    expect(isPluginSecurityRequestAllowed(ceiling, { network: "unrestricted" })).toBe(false);
    expect(isPluginSecurityRequestAllowed(ceiling, { approvals: "preapproved" })).toBe(false);
    expect(isPluginSecurityRequestAllowed(ceiling, { unattended: "allowed" })).toBe(false);
  });

  test("treats unknown policy facts as restrictive while allowing explicit no-access", () => {
    const unknown = {
      filesystem: "unknown",
      network: "unknown",
      approvals: "unknown",
      unattended: "unknown",
    } as const;
    expect(isPluginSecurityRequestAllowed(unknown, { filesystem: "workspace" })).toBe(false);
    expect(isPluginSecurityRequestAllowed(unknown, { network: "none" })).toBe(true);
    expect(isPluginSecurityRequestAllowed(unknown, { unattended: "forbidden" })).toBe(true);
  });
});

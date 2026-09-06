import { describe, expect, it } from "vitest";
import {
  type HostAppearanceSource,
  defaultHostAppearance,
  normalizeStoredHostAppearance,
  resolveHostBadgeDisplay,
  resolveHostColor,
  selectHostBadges,
} from "@/hosts/appearance";
import { deriveIdentityColorName } from "@/styles/identity-colors";

function host(
  serverId: string,
  label: string,
  appearance = defaultHostAppearance(),
  declaredColor: HostAppearanceSource["declaredColor"] = null,
): HostAppearanceSource {
  return { serverId, label, appearance, declaredColor };
}

describe("resolveHostColor", () => {
  it("derives a color from the server id when nobody chose one", () => {
    expect(
      resolveHostColor({
        serverId: "alpha",
        appearance: defaultHostAppearance(),
        declaredColor: null,
      }),
    ).toBe(deriveIdentityColorName("alpha"));
  });

  it("prefers the color the host declares over the derived one", () => {
    expect(
      resolveHostColor({
        serverId: "alpha",
        appearance: defaultHostAppearance(),
        declaredColor: "red",
      }),
    ).toBe("red");
  });

  it("lets a device override the host's declared color", () => {
    expect(
      resolveHostColor({
        serverId: "alpha",
        appearance: { color: "teal", badgeDisplay: null },
        declaredColor: "red",
      }),
    ).toBe("teal");
  });
});

describe("normalizeStoredHostAppearance", () => {
  it("defaults when the stored registry predates the field or holds junk", () => {
    const expected = { color: "none", badgeDisplay: null };
    expect(normalizeStoredHostAppearance(undefined)).toEqual(expected);
    expect(normalizeStoredHostAppearance(null)).toEqual(expected);
    expect(normalizeStoredHostAppearance("x")).toEqual(expected);
    expect(normalizeStoredHostAppearance({})).toEqual(expected);
    expect(normalizeStoredHostAppearance({ color: "chartreuse" })).toEqual(expected);
    expect(normalizeStoredHostAppearance({ badgeDisplay: "loud" })).toEqual(expected);
  });

  it("round-trips a value the user actually chose", () => {
    expect(normalizeStoredHostAppearance({ color: "teal", badgeDisplay: "icon" })).toEqual({
      color: "teal",
      badgeDisplay: "icon",
    });
  });
});

describe("resolveHostBadgeDisplay", () => {
  it("hides the badge for the local host until the user chooses", () => {
    expect(
      resolveHostBadgeDisplay({ appearance: defaultHostAppearance(), isLocalHost: true }),
    ).toBe("hidden");
  });

  it("names a remote host until the user chooses", () => {
    expect(
      resolveHostBadgeDisplay({ appearance: defaultHostAppearance(), isLocalHost: false }),
    ).toBe("name");
  });

  it("prefers an explicit choice over either default", () => {
    expect(
      resolveHostBadgeDisplay({
        appearance: { color: "none", badgeDisplay: "icon" },
        isLocalHost: true,
      }),
    ).toBe("icon");
    expect(
      resolveHostBadgeDisplay({
        appearance: { color: "none", badgeDisplay: "hidden" },
        isLocalHost: false,
      }),
    ).toBe("hidden");
  });

  it("defers only the default while local-host detection is unresolved", () => {
    expect(
      resolveHostBadgeDisplay({
        appearance: defaultHostAppearance(),
        isLocalHost: false,
        localHostResolutionPending: true,
      }),
    ).toBeNull();
    expect(
      resolveHostBadgeDisplay({
        appearance: { color: "none", badgeDisplay: "icon" },
        isLocalHost: false,
        localHostResolutionPending: true,
      }),
    ).toBe("icon");
  });
});

describe("selectHostBadges", () => {
  it("shows no badges while the sidebar spans a single host", () => {
    const badges = selectHostBadges({
      hosts: [host("alpha", "Alpha"), host("beta", "Beta")],
      localServerId: null,
      enabled: false,
    });
    expect(badges.size).toBe(0);
  });

  it("omits a host the user hid and keeps its sibling", () => {
    const badges = selectHostBadges({
      hosts: [
        host("alpha", "Alpha", { color: "none", badgeDisplay: "hidden" }),
        host("beta", "Beta"),
      ],
      localServerId: null,
      enabled: true,
    });
    expect(badges.has("alpha")).toBe(false);
    expect(badges.get("beta")).toEqual({
      serverId: "beta",
      label: "Beta",
      color: deriveIdentityColorName("beta"),
      showLabel: true,
    });
  });

  it("keeps an icon-only host in the map without its label", () => {
    const badges = selectHostBadges({
      hosts: [host("alpha", "Alpha", { color: "teal", badgeDisplay: "icon" })],
      localServerId: null,
      enabled: true,
    });
    expect(badges.get("alpha")).toEqual({
      serverId: "alpha",
      label: "Alpha",
      color: "teal",
      showLabel: false,
    });
  });

  it("draws the host's declared color when the device has not chosen", () => {
    const badges = selectHostBadges({
      hosts: [host("alpha", "Alpha", defaultHostAppearance(), "amber")],
      localServerId: null,
      enabled: true,
    });
    expect(badges.get("alpha")?.color).toBe("amber");
  });

  it("falls back to the server id when the label is blank", () => {
    const badges = selectHostBadges({
      hosts: [host("alpha", "   ")],
      localServerId: null,
      enabled: true,
    });
    expect(badges.get("alpha")?.label).toBe("alpha");
  });

  it("hides an untouched local host while its remote sibling shows", () => {
    const badges = selectHostBadges({
      hosts: [host("alpha", "Alpha"), host("beta", "Beta")],
      localServerId: "alpha",
      enabled: true,
    });
    expect(badges.has("alpha")).toBe(false);
    expect(badges.get("beta")?.label).toBe("Beta");
  });

  it("omits untouched badges while local-host detection is unresolved", () => {
    const badges = selectHostBadges({
      hosts: [host("alpha", "Alpha"), host("beta", "Beta")],
      localServerId: null,
      localHostResolutionPending: true,
      enabled: true,
    });
    expect(badges.size).toBe(0);
  });
});

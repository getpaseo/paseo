import { describe, expect, it } from "vitest";
import {
  type HostAppearanceSource,
  defaultHostAppearance,
  normalizeStoredHostAppearance,
  resolveHostBadgeDisplay,
  resolveHostIcon,
  selectHostBadges,
} from "@/hosts/appearance";

function host(
  serverId: string,
  label: string,
  appearance = defaultHostAppearance(),
): HostAppearanceSource {
  return { serverId, label, appearance };
}

describe("normalizeStoredHostAppearance", () => {
  it("defaults without writing an icon field so untouched records stay downgrade-safe", () => {
    const expected = { color: "none", badgeDisplay: null };
    expect(normalizeStoredHostAppearance(undefined)).toEqual(expected);
    expect(normalizeStoredHostAppearance(null)).toEqual(expected);
    expect(normalizeStoredHostAppearance("x")).toEqual(expected);
    expect(normalizeStoredHostAppearance({})).toEqual(expected);
    expect(normalizeStoredHostAppearance({ color: "chartreuse" })).toEqual(expected);
    expect(normalizeStoredHostAppearance({ badgeDisplay: "loud" })).toEqual(expected);
    expect("icon" in defaultHostAppearance()).toBe(false);
  });

  it("preserves an unknown stored icon on disk while falling back at render time", () => {
    const normalized = normalizeStoredHostAppearance({
      color: "teal",
      icon: "spaceship",
      badgeDisplay: "icon",
    });
    expect(normalized).toEqual({
      color: "teal",
      icon: "spaceship",
      badgeDisplay: "icon",
    });
    expect(resolveHostIcon({ appearance: normalized })).toBe("server");
    expect(resolveHostIcon({ appearance: normalized, detectedMachineKind: "laptop" })).toBe(
      "laptop",
    );
  });

  it("keeps icon absent on stored entries that predate host icons", () => {
    const normalized = normalizeStoredHostAppearance({ color: "teal", badgeDisplay: "icon" });
    expect(normalized).toEqual({
      color: "teal",
      badgeDisplay: "icon",
    });
    expect("icon" in normalized).toBe(false);
  });

  it("round-trips a value the user actually chose", () => {
    expect(
      normalizeStoredHostAppearance({ color: "teal", icon: "laptop", badgeDisplay: "icon" }),
    ).toEqual({
      color: "teal",
      icon: "laptop",
      badgeDisplay: "icon",
    });
  });
});

describe("resolveHostIcon", () => {
  it("prefers an explicit user icon over daemon auto-detection", () => {
    expect(
      resolveHostIcon({
        appearance: { color: "none", icon: "workstation", badgeDisplay: null },
        detectedMachineKind: "laptop",
      }),
    ).toBe("workstation");
  });

  it("uses the daemon-detected machine kind while the user icon is auto (null)", () => {
    expect(
      resolveHostIcon({
        appearance: defaultHostAppearance(),
        detectedMachineKind: "laptop",
      }),
    ).toBe("laptop");
    expect(
      resolveHostIcon({
        appearance: defaultHostAppearance(),
        detectedMachineKind: "container",
      }),
    ).toBe("container");
  });

  it("falls back to server when the detected machine kind is absent or unknown", () => {
    expect(resolveHostIcon({ appearance: defaultHostAppearance() })).toBe("server");
    expect(
      resolveHostIcon({ appearance: defaultHostAppearance(), detectedMachineKind: null }),
    ).toBe("server");
    expect(
      resolveHostIcon({ appearance: defaultHostAppearance(), detectedMachineKind: "future-kind" }),
    ).toBe("server");
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
        appearance: { color: "none", icon: "server", badgeDisplay: "icon" },
        isLocalHost: true,
      }),
    ).toBe("icon");
    expect(
      resolveHostBadgeDisplay({
        appearance: { color: "none", icon: "server", badgeDisplay: "hidden" },
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
        appearance: { color: "none", icon: "server", badgeDisplay: "icon" },
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
        host("alpha", "Alpha", { color: "none", icon: "server", badgeDisplay: "hidden" }),
        host("beta", "Beta"),
      ],
      localServerId: null,
      enabled: true,
    });
    expect(badges.has("alpha")).toBe(false);
    expect(badges.get("beta")).toEqual({
      serverId: "beta",
      label: "Beta",
      color: "none",
      icon: "server",
      showLabel: true,
    });
  });

  it("keeps an icon-only host in the map without its label", () => {
    const badges = selectHostBadges({
      hosts: [host("alpha", "Alpha", { color: "teal", icon: "mini", badgeDisplay: "icon" })],
      localServerId: null,
      enabled: true,
    });
    expect(badges.get("alpha")).toEqual({
      serverId: "alpha",
      label: "Alpha",
      color: "teal",
      icon: "mini",
      showLabel: false,
    });
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

  it("applies daemon-detected machine kind for auto icons while respecting explicit overrides", () => {
    const badges = selectHostBadges({
      hosts: [
        host("alpha", "Alpha"),
        host("beta", "Beta", { color: "sky", icon: "workstation", badgeDisplay: "name" }),
      ],
      localServerId: null,
      detectedMachineKindByServerId: new Map([
        ["alpha", "laptop"],
        ["beta", "cloud"],
      ]),
      enabled: true,
    });
    expect(badges.get("alpha")?.icon).toBe("laptop");
    expect(badges.get("beta")?.icon).toBe("workstation");
  });
});

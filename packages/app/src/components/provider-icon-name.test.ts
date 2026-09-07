import { describe, expect, it } from "vitest";
import {
  BUILTIN_PROVIDER_ICON_NAMES,
  KNOWN_PROVIDER_ICON_NAMES,
  TERMINAL_PROFILE_ICON_NAMES,
} from "@getpaseo/protocol/provider-icon-names";
import { ACP_PROVIDER_CATALOG } from "@/data/acp-provider-catalog";
import { replaceProviderSnapshotIcons, resolveProviderIconName } from "./provider-icon-name";

describe("resolveProviderIconName", () => {
  it("returns the built-in identifier for known provider ids", () => {
    expect(resolveProviderIconName("kiro")).toEqual({ kind: "builtin", id: "kiro" });
    expect(resolveProviderIconName("claude")).toEqual({ kind: "builtin", id: "claude" });
    expect(resolveProviderIconName("omp")).toEqual({ kind: "builtin", id: "omp" });
    expect(resolveProviderIconName("minimax")).toEqual({ kind: "builtin", id: "minimax" });
  });

  it("returns the catalog identifier for ACP catalog provider ids that ship an icon", () => {
    expect(resolveProviderIconName("amp-acp")).toEqual({ kind: "catalog", id: "amp-acp" });
    expect(resolveProviderIconName("gemini")).toEqual({ kind: "catalog", id: "gemini" });
    expect(resolveProviderIconName("gjc")).toEqual({ kind: "catalog", id: "gjc" });
    expect(resolveProviderIconName("traecli")).toEqual({ kind: "catalog", id: "traecli" });
  });

  it("falls back to the bot icon for unknown custom providers", () => {
    expect(resolveProviderIconName("custom-claude-profile")).toEqual({ kind: "bot" });
  });

  it("resolves a snapshot SVG for a custom provider", () => {
    const svg = '<svg viewBox="0 0 24 24"><path d="M4 4h16v16H4z" /></svg>';

    replaceProviderSnapshotIcons("server-1", [{ provider: "snapshot-provider", iconSvg: svg }]);

    expect(resolveProviderIconName("snapshot-provider", "server-1")).toEqual({ kind: "svg", svg });
  });

  it("replaces each host snapshot without leaking icons across hosts", () => {
    const secondSvg = "<svg id='second' />";
    replaceProviderSnapshotIcons("server-1", [
      { provider: "removed-provider", iconSvg: "<svg />" },
      { provider: "snapshot-provider", iconSvg: "<svg />" },
      { provider: "claude", iconSvg: "<svg />" },
    ]);
    replaceProviderSnapshotIcons("server-2", [
      { provider: "snapshot-provider", iconSvg: secondSvg },
    ]);

    expect(resolveProviderIconName("snapshot-provider", "server-1")).toEqual({
      kind: "svg",
      svg: "<svg />",
    });
    expect(resolveProviderIconName("snapshot-provider", "server-2")).toEqual({
      kind: "svg",
      svg: secondSvg,
    });
    expect(resolveProviderIconName("claude", "server-1")).toEqual({
      kind: "builtin",
      id: "claude",
    });

    replaceProviderSnapshotIcons("server-1", [{ provider: "snapshot-provider" }]);

    expect(resolveProviderIconName("removed-provider", "server-1")).toEqual({ kind: "bot" });
    expect(resolveProviderIconName("snapshot-provider", "server-1")).toEqual({ kind: "bot" });
    expect(resolveProviderIconName("snapshot-provider", "server-2")).toEqual({
      kind: "svg",
      svg: secondSvg,
    });
  });
});

describe("known provider icon names", () => {
  it("includes every ACP catalog entry that ships an icon", () => {
    const known = new Set(KNOWN_PROVIDER_ICON_NAMES);
    for (const entry of ACP_PROVIDER_CATALOG) {
      if (entry.iconSvg) {
        expect(known).toContain(entry.id);
      }
    }
  });

  it("only lists ACP icon ids that have a catalog entry with an icon", () => {
    const builtin = new Set(BUILTIN_PROVIDER_ICON_NAMES);
    const terminalOnly = new Set(TERMINAL_PROFILE_ICON_NAMES);
    const catalogIdsWithIcons = new Set(
      ACP_PROVIDER_CATALOG.filter((entry) => entry.iconSvg).map((entry) => entry.id),
    );
    for (const name of KNOWN_PROVIDER_ICON_NAMES) {
      if (!builtin.has(name) && !terminalOnly.has(name)) {
        expect(catalogIdsWithIcons).toContain(name);
      }
    }
  });
});

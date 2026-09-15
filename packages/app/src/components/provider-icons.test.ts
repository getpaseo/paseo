import { Bot } from "lucide-react-native";
import { SvgXml } from "react-native-svg";
import { TERMINAL_PROFILE_ICON_NAMES } from "@getpaseo/protocol/provider-icon-names";
import { describe, expect, it } from "vitest";
import { replaceProviderSnapshotIcons } from "./provider-icon-name";
import { getProviderIcon, type ProviderIconComponent } from "./provider-icons";

function renderIcon(Component: ProviderIconComponent) {
  if (typeof Component !== "function") throw new Error("Expected a function component");
  return (Component as (props: { size: number; color: string }) => unknown)({
    size: 18,
    color: "#123456",
  });
}

describe("getProviderIcon", () => {
  it("renders registered snapshot SVG metadata with the requested size and color", () => {
    const svg = '<svg viewBox="0 0 24 24"><path d="M4 4h16v16H4z" /></svg>';
    replaceProviderSnapshotIcons("server-1", [{ provider: "rendered-provider", iconSvg: svg }]);

    const rendered = renderIcon(getProviderIcon("rendered-provider", "server-1"));

    expect(rendered).toMatchObject({
      type: SvgXml,
      props: { xml: svg, width: 18, height: 18, color: "#123456" },
    });
  });

  it("uses the normal Bot fallback without snapshot SVG metadata", () => {
    replaceProviderSnapshotIcons("server-1", [{ provider: "plain-provider" }]);

    expect(getProviderIcon("plain-provider", "server-1")).toBe(Bot);
  });

  it("renders the shipped SVG for the agy terminal-profile icon instead of the Bot", () => {
    const icon = getProviderIcon("agy");
    expect(icon).not.toBe(Bot);
    expect(icon.displayName).toBe("SvgProviderIcon(agy)");
  });

  it("resolves every registered terminal-profile icon to its shipped SVG, not the Bot", () => {
    for (const name of TERMINAL_PROFILE_ICON_NAMES) {
      const icon = getProviderIcon(name);
      expect(icon, `terminal-profile icon "${name}" fell back to Bot`).not.toBe(Bot);
      expect(icon.displayName).toBe(`SvgProviderIcon(${name})`);
    }
  });

  it("still resolves ACP catalog icons to their SVG (the seeded map is shared)", () => {
    expect(getProviderIcon("cursor")).not.toBe(Bot);
  });

  it("falls back to the Bot for an unknown icon id", () => {
    expect(getProviderIcon("definitely-not-a-real-icon")).toBe(Bot);
  });
});

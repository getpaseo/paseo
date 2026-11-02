import { Settings } from "lucide-react-native";
import React, { isValidElement, type ReactElement, type ReactNode } from "react";
import { SvgXml } from "react-native-svg";
import { describe, expect, it } from "vitest";
import type { PluginIconProps } from "@getpaseo/plugin";
import { Icon, parsePluginIcon, parseSerializablePluginIcon, PluginIconView } from "./icons";

const SVG = '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M4 4h16v16H4z" /></svg>';
const SVG_ICON = { svg: SVG };

const GLYPHS = new Set<unknown>([Settings, SvgXml]);

/** Expands function components down to what reaches the screen: a Lucide glyph, SvgXml, or DOM. */
function draw(node: ReactNode): ReactElement | null {
  if (!isValidElement(node)) return null;
  const { type } = node;
  if (typeof type !== "function" || GLYPHS.has(type)) return node;
  return draw((type as (props: unknown) => ReactNode)(node.props));
}

function BadgeIcon({ size, color }: PluginIconProps) {
  return <span data-size={size} data-color={color} />;
}

describe("PluginIconView", () => {
  it("draws a Lucide name as that Lucide icon", () => {
    expect(draw(<PluginIconView icon="Settings" size={18} color="#123456" />)).toMatchObject({
      type: Settings,
      props: { size: 18, color: "#123456" },
    });
  });

  it("draws inline SVG sized to the surface, with color reaching currentColor", () => {
    expect(draw(<PluginIconView icon={SVG_ICON} size={18} color="#123456" />)).toMatchObject({
      type: SvgXml,
      props: { xml: SVG, width: 18, height: 18, color: "#123456" },
    });
  });

  it("draws a component with the surface's size and color", () => {
    expect(draw(<PluginIconView icon={BadgeIcon} size={18} color="#123456" />)).toMatchObject({
      type: "span",
      props: { "data-size": 18, "data-color": "#123456" },
    });
  });
});

describe("parsePluginIcon", () => {
  it("normalizes each icon form", () => {
    expect(parsePluginIcon("Workspace panel files", " Settings ")).toBe("Settings");
    expect(parsePluginIcon("Workspace panel files", { svg: `\n${SVG}\n` })).toEqual({ svg: SVG });
    expect(parsePluginIcon("Workspace panel files", BadgeIcon)).toBe(BadgeIcon);
  });

  it.each([
    ["", "Workspace panel files has no icon"],
    [
      "NotALucideIcon",
      'Workspace panel files has an invalid icon: unknown Lucide icon "NotALucideIcon"',
    ],
    [
      { svg: "<svg><script>run()</script></svg>" },
      "Workspace panel files has an invalid icon: script elements are not allowed",
    ],
    [{ svg: "hello" }, "Workspace panel files has an invalid icon: not an SVG document"],
    [
      { path: "icon.svg" },
      "Workspace panel files has an invalid icon: expected a Lucide icon name, { svg }, or a component",
    ],
  ])("rejects %j", (icon, message) => {
    expect(() => parsePluginIcon("Workspace panel files", icon as never)).toThrow(message);
  });

  it("refuses a component where the icon is stored as data", () => {
    expect(() =>
      parseSerializablePluginIcon("Attachment source issues", BadgeIcon as never),
    ).toThrow(
      "Attachment source issues has an invalid icon: expected a Lucide icon name or { svg }",
    );
  });
});

describe("Icon", () => {
  it("renders a host Lucide icon by name with the requested presentation", () => {
    expect(draw(Icon({ name: "Settings", size: 18, color: "#123456" }))).toMatchObject({
      type: Settings,
      props: { size: 18, color: "#123456" },
    });
  });

  it("renders a plugin's own SVG through the icon prop", () => {
    expect(draw(Icon({ icon: { svg: SVG }, size: 18, color: "#123456" }))).toMatchObject({
      type: SvgXml,
      props: { xml: SVG, width: 18, color: "#123456" },
    });
  });

  it("renders nothing for an unusable icon", () => {
    expect(Icon({ name: "NotALucideIcon" })).toBeNull();
    expect(Icon({ name: "Icon" })).toBeNull();
    expect(Icon({ name: "createLucideIcon" })).toBeNull();
    expect(Icon({ icon: { svg: '<svg onload="run()"></svg>' } })).toBeNull();
  });
});

// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { Bot, PackagePlus } from "lucide-react-native";
import { SvgXml } from "react-native-svg";
import { afterEach, describe, expect, it } from "vitest";
import { replaceProviderSnapshotIcons } from "@/data/provider-icons";
import { useProviderIcon, useProviderIcons, type ProviderIconComponent } from "./provider-icons";

afterEach(cleanup);

function renderIcon(Component: ProviderIconComponent) {
  if (typeof Component !== "function") throw new Error("Expected a function component");
  return (Component as (props: { size: number; color: string }) => unknown)({
    size: 18,
    color: "#123456",
  });
}

describe("useProviderIcon", () => {
  it.each([
    ["claude", "#D97757"],
    ["codex", "#10A37F"],
    ["kimi", "#7C3AED"],
    ["kiro", "#9046FF"],
    ["agy", "#3186FF"],
    ["traecli", "#2563EB"],
  ])("uses the brand color for %s on native clients", (provider, brandColor) => {
    const Icon = renderHook(() => useProviderIcon(provider)).result.current;
    const rendered = renderIcon(Icon) as { props: { color?: string; fill?: string } };

    expect(rendered.props.color ?? rendered.props.fill).toBe(brandColor);
  });

  it.each([
    ["seed", "#A569FF"],
    ["doubao", "#37E1BE"],
    ["deepseek", "#4D6BFE"],
  ])("renders branded artwork for %s without host metadata", (provider, fill) => {
    const Icon = renderHook(() => useProviderIcon(provider)).result.current;

    expect(renderIcon(Icon)).toMatchObject({
      type: SvgXml,
      props: { xml: expect.stringContaining(`fill="${fill}"`) },
    });
  });
  it.each(["devin", "hermes", "kiro", "antigravity"])(
    "#7087: %s has a provider mark before a host snapshot arrives",
    (provider) => {
      const Icon = renderHook(() => useProviderIcon(provider)).result.current;
      expect(Icon).not.toBe(Bot);
      expect(Icon).not.toBe(PackagePlus);
      expect(typeof Icon).toBe("function");
    },
  );

  it("renders registered snapshot SVG metadata with the requested size and color", () => {
    const svg = '<svg viewBox="0 0 24 24"><path d="M4 4h16v16H4z" /></svg>';
    replaceProviderSnapshotIcons("server-1", [{ provider: "rendered-provider", iconSvg: svg }]);

    const rendered = renderIcon(
      renderHook(() => useProviderIcon("rendered-provider", "server-1")).result.current,
    );

    expect(rendered).toMatchObject({
      type: SvgXml,
      props: { xml: svg, width: 18, height: 18, color: "#123456" },
    });
  });

  it("uses the normal Bot fallback without snapshot SVG metadata", () => {
    replaceProviderSnapshotIcons("server-1", [{ provider: "plain-provider" }]);

    expect(renderHook(() => useProviderIcon("plain-provider", "server-1")).result.current).toBe(
      Bot,
    );
  });
});

it("updates a mounted consumer when the plugin snapshot arrives after mount", () => {
  const serverId = "cold-reload-host";
  const provider = "plugin-provider";
  const svg = '<svg viewBox="0 0 24 24"><path d="M4 4h16v16H4z" /></svg>';
  replaceProviderSnapshotIcons(serverId, []);
  const { result, unmount } = renderHook(() => useProviderIcon(provider, serverId));
  expect(result.current).toBe(Bot);
  act(() => replaceProviderSnapshotIcons(serverId, [{ provider, iconSvg: svg }]));
  expect(renderIcon(result.current)).toMatchObject({
    type: SvgXml,
    props: { xml: svg, width: 18, height: 18, color: "#123456" },
  });
  unmount();
});

it("keeps host SVGs isolated, updates replacements, and clears removed icons", () => {
  const provider = "shared-plugin-provider";
  const firstSvg = '<svg id="first" />';
  const secondSvg = '<svg id="second" />';
  replaceProviderSnapshotIcons("first-host", [{ provider, iconSvg: firstSvg }]);
  replaceProviderSnapshotIcons("second-host", [{ provider, iconSvg: secondSvg }]);
  const first = renderHook(() => useProviderIcon(provider, "first-host"));
  const second = renderHook(() => useProviderIcon(provider, "second-host"));
  const firstIcon = first.result.current;
  expect(renderIcon(firstIcon)).toMatchObject({ props: { xml: firstSvg } });
  expect(renderIcon(second.result.current)).toMatchObject({ props: { xml: secondSvg } });
  act(() => replaceProviderSnapshotIcons("second-host", [{ provider, iconSvg: firstSvg }]));
  expect(renderIcon(second.result.current)).toMatchObject({ props: { xml: firstSvg } });
  expect(first.result.current).toBe(firstIcon);
  act(() => replaceProviderSnapshotIcons("second-host", []));
  expect(second.result.current).toBe(Bot);
  expect(first.result.current).toBe(firstIcon);
});

it("updates collection consumers when their host snapshot arrives", () => {
  const serverId = "collection-host";
  const provider = "collection-plugin-provider";
  const svg = '<svg id="collection" />';
  replaceProviderSnapshotIcons(serverId, []);
  const { result } = renderHook(() => useProviderIcons(serverId));
  expect(result.current(provider)).toBe(Bot);
  act(() => replaceProviderSnapshotIcons(serverId, [{ provider, iconSvg: svg }]));
  expect(renderIcon(result.current(provider))).toMatchObject({ props: { xml: svg } });
});

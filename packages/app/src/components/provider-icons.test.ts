// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { Bot } from "lucide-react-native";
import { SvgXml } from "react-native-svg";
import { afterEach, describe, expect, it } from "vitest";
import { HermesIcon } from "@/components/icons/hermes-icon";
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
  it("uses the official Hermes icon for individual and collection consumers", () => {
    expect(renderHook(() => useProviderIcon("hermes")).result.current).toBe(HermesIcon);
    expect(renderHook(() => useProviderIcons()).result.current("hermes")).toBe(HermesIcon);
    expect(renderIcon(HermesIcon)).toMatchObject({
      props: {
        width: 18,
        height: 18,
        fill: "#123456",
        viewBox: "100 60 5120 6110",
        children: {
          props: { transform: "matrix(1.0330354,0,0,1.0330354,-145.41428,-2499.328)" },
        },
      },
    });
  });

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

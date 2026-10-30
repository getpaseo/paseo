// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { Bot, PackagePlus, Star, Heart } from "lucide-react-native";
import { isValidElement, type ReactNode } from "react";
import { SvgXml } from "react-native-svg";
import { afterEach, describe, expect, it } from "vitest";
import {
  providerIconOverrides,
  replaceProviderIconOverrides,
  replaceProviderSnapshotIcons,
} from "@/data/provider-icons";
import { useProviderIcon, useProviderIcons, type ProviderIconComponent } from "./provider-icons";

afterEach(() => {
  cleanup();
  replaceProviderIconOverrides([]);
});

const GLYPHS = new Set<unknown>([Bot, Star, Heart, SvgXml]);

function draw(node: ReactNode): ReactNode {
  if (!isValidElement(node) || typeof node.type !== "function" || GLYPHS.has(node.type))
    return node;
  return draw((node.type as (props: unknown) => ReactNode)(node.props));
}

function renderIcon(Component: ProviderIconComponent) {
  if (typeof Component !== "function") throw new Error("Expected a function component");
  return draw(
    (Component as (props: { size: number; color: string }) => ReactNode)({
      size: 18,
      color: "#123456",
    }),
  );
}

type IconInstallation = Parameters<typeof replaceProviderIconOverrides>[0][number];

function installation(
  id: string,
  serverId: string,
  overrides: IconInstallation["providerIconOverrides"],
): IconInstallation {
  return { id, serverId, providerIconOverrides: overrides };
}

describe("useProviderIcon", () => {
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

it("overrides built-in and custom provider icons on its host and restores both on removal", () => {
  const serverId = "override-host";
  const provider = "custom-provider";
  const svg = '<svg viewBox="0 0 24 24"><path d="M2 2h20v20H2z" /></svg>';
  replaceProviderSnapshotIcons(serverId, [{ provider, iconSvg: svg }]);
  const builtin = renderHook(() => useProviderIcon("codex", serverId));
  const custom = renderHook(() => useProviderIcon(provider, serverId));
  const collection = renderHook(() => useProviderIcons(serverId));
  const originalBuiltin = builtin.result.current;
  const originalCustom = custom.result.current;

  act(() =>
    replaceProviderIconOverrides([
      installation("icons", serverId, [
        { id: "builtin", provider: "codex", icon: "Star" },
        { id: "custom", provider, icon: "Heart" },
      ]),
    ]),
  );

  expect(renderIcon(builtin.result.current)).toMatchObject({
    type: Star,
    props: { size: 18, color: "#123456" },
  });
  expect(renderIcon(custom.result.current)).toMatchObject({ type: Heart });
  expect(collection.result.current("codex")).toBe(builtin.result.current);
  expect(collection.result.current(provider)).toBe(custom.result.current);

  act(() => replaceProviderIconOverrides([]));
  expect(builtin.result.current).toBe(originalBuiltin);
  expect(custom.result.current).toBe(originalCustom);
  expect(collection.result.current(provider)).toBe(originalCustom);
});

it("keeps overrides isolated by host and does not guess a host for unscoped icons", () => {
  const first = renderHook(() => useProviderIcon("codex", "isolated-first"));
  const second = renderHook(() => useProviderIcon("codex", "isolated-second"));
  const unscoped = renderHook(() => useProviderIcon("codex"));
  const original = unscoped.result.current;
  act(() =>
    replaceProviderIconOverrides([
      installation("same-plugin", "isolated-first", [
        { id: "brand", provider: "codex", icon: "Star" },
      ]),
      installation("same-plugin", "isolated-second", [
        { id: "brand", provider: "codex", icon: "Heart" },
      ]),
    ]),
  );
  expect(renderIcon(first.result.current)).toMatchObject({ type: Star });
  expect(renderIcon(second.result.current)).toMatchObject({ type: Heart });
  expect(unscoped.result.current).toBe(original);

  act(() =>
    replaceProviderIconOverrides([
      installation("same-plugin", "isolated-second", [
        { id: "brand", provider: "codex", icon: "Heart" },
      ]),
    ]),
  );
  expect(first.result.current).toBe(original);
  expect(renderIcon(second.result.current)).toMatchObject({ type: Heart });
});

it("resolves conflicts by plugin ID then contribution ID independently of registration order", () => {
  const serverId = "conflicting-host";
  const provider = "codex";
  const laterPlugin = installation("z-plugin", serverId, [{ id: "a", provider, icon: "Heart" }]);
  const firstPlugin = installation("a-plugin", serverId, [
    { id: "z", provider, icon: "Heart" },
    { id: "a", provider, icon: "Star" },
  ]);
  const { result } = renderHook(() => useProviderIcon(provider, serverId));
  const original = result.current;
  act(() => replaceProviderIconOverrides([laterPlugin, firstPlugin]));
  expect(renderIcon(result.current)).toMatchObject({ type: Star });
  const selected = result.current;
  act(() =>
    replaceProviderIconOverrides([
      { ...firstPlugin, providerIconOverrides: firstPlugin.providerIconOverrides.toReversed() },
      laterPlugin,
    ]),
  );
  expect(result.current).toBe(selected);

  act(() => replaceProviderIconOverrides([laterPlugin]));
  expect(renderIcon(result.current)).toMatchObject({ type: Heart });
  act(() => replaceProviderIconOverrides([]));
  expect(result.current).toBe(original);
});

it("keeps other host collection selectors stable when overrides reload", () => {
  const first = installation("icons", "stable-first", [
    { id: "brand", provider: "codex", icon: "Star" },
  ]);
  const second = installation("icons", "stable-second", [
    { id: "brand", provider: "codex", icon: { svg: '<svg viewBox="0 0 24 24" />' } },
  ]);
  replaceProviderIconOverrides([first, second]);
  const { result } = renderHook(() => useProviderIcons("stable-second"));
  const resolve = result.current;
  const state = providerIconOverrides.getState();
  act(() => replaceProviderIconOverrides([second, first]));
  expect(providerIconOverrides.getState()).toBe(state);
  act(() =>
    replaceProviderIconOverrides([
      { ...first, providerIconOverrides: [{ id: "brand", provider: "codex", icon: "Heart" }] },
      {
        ...second,
        providerIconOverrides: [
          { id: "brand", provider: "codex", icon: { svg: '<svg viewBox="0 0 24 24" />' } },
        ],
      },
    ]),
  );
  expect(result.current).toBe(resolve);
});

it("renders override SVG at the requested size with a safe fallback for malformed XML", () => {
  const svg = '<svg viewBox="0 0 24 24"><path';
  replaceProviderIconOverrides([
    installation("icons", "malformed-host", [{ id: "brand", provider: "codex", icon: { svg } }]),
  ]);
  const { result } = renderHook(() => useProviderIcon("codex", "malformed-host"));
  expect(renderIcon(result.current)).toMatchObject({
    type: SvgXml,
    props: {
      xml: svg,
      width: 18,
      height: 18,
      color: "#123456",
      fallback: { type: Bot, props: { size: 18, color: "#123456" } },
    },
  });
});

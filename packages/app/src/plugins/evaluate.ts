import * as React from "react";
import * as ReactJsxRuntime from "react/jsx-runtime";
import * as ReactNative from "react-native";
// eslint-disable-next-line no-restricted-imports -- plugin bundles receive TanStack's real runtime, not Paseo's query wrappers.
import * as ReactQuery from "@tanstack/react-query";
import * as Zod from "zod";
import { createPluginContext, defineRpc, type PluginRegistrationCollector, useRpc } from "./sdk";
import type { EvaluatedPlugin, PluginSidebarContribution, PluginSurfaceProps } from "./types";
import type { ComponentType } from "react";
import { resolvePluginIcon } from "./icons";

const CONTRIBUTION_ID = /^[a-z][a-z0-9-]*$/;

function requireId(value: string, label: string): string {
  const id = value.trim();
  if (!CONTRIBUTION_ID.test(id)) throw new Error(`Invalid ${label}: ${value}`);
  return id;
}

export function evaluatePluginClientBundle(id: string, bundle: string): EvaluatedPlugin {
  const collector: PluginRegistrationCollector = { surfaces: [], sidebarItems: [] };
  const surfaceIds = new Set<string>();
  const sidebarItemIds = new Set<string>();
  const pluginContext = createPluginContext({
    addSurface(surfaceId: string, Component: ComponentType<PluginSurfaceProps>) {
      const normalizedId = requireId(surfaceId, "surface id");
      if (surfaceIds.has(normalizedId)) throw new Error(`Duplicate surface: ${normalizedId}`);
      if (typeof Component !== "function")
        throw new Error(`Surface ${normalizedId} is not a component`);
      surfaceIds.add(normalizedId);
      collector.surfaces.push({ id: normalizedId, Component });
    },
    addSidebarItem(contribution: PluginSidebarContribution) {
      const normalizedId = requireId(contribution.id, "sidebar item id");
      if (sidebarItemIds.has(normalizedId))
        throw new Error(`Duplicate sidebar item: ${normalizedId}`);
      if (!contribution.title.trim()) throw new Error(`Sidebar item ${normalizedId} has no title`);
      if (!contribution.icon.trim()) throw new Error(`Sidebar item ${normalizedId} has no icon`);
      resolvePluginIcon(contribution.icon.trim());
      sidebarItemIds.add(normalizedId);
      collector.sidebarItems.push({
        id: normalizedId,
        title: contribution.title.trim(),
        icon: contribution.icon.trim(),
        surface: requireId(contribution.surface, "sidebar surface id"),
      });
    },
  });
  const runtimeRequire = (name: string): unknown => {
    if (name === "react") return React;
    if (name === "react/jsx-runtime") return ReactJsxRuntime;
    if (name === "react-native") return ReactNative;
    if (name === "@paseo/plugin") return { defineRpc, useRpc };
    if (name === "@tanstack/react-query") return ReactQuery;
    if (name === "zod") return Zod;
    throw new Error(`Module "${name}" is not available in plugin client code`);
  };
  const evaluate: (source: string) => unknown = globalThis.eval;
  const factory = evaluate(bundle);
  if (typeof factory !== "function")
    throw new Error(`Plugin ${id} client bundle is not executable`);
  const exports = factory(runtimeRequire);
  const setup =
    exports !== null && typeof exports === "object" ? Reflect.get(exports, "default") : undefined;
  if (typeof setup !== "function") {
    throw new Error(`Plugin ${id} must default export a function`);
  }
  setup(pluginContext);

  for (const item of collector.sidebarItems) {
    if (!surfaceIds.has(item.surface)) {
      throw new Error(`Sidebar item ${item.id} references missing surface ${item.surface}`);
    }
  }
  return { id, surfaces: collector.surfaces, sidebarItems: collector.sidebarItems };
}

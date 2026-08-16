import * as React from "react";
import * as ReactJsxRuntime from "react/jsx-runtime";
import * as ReactNative from "react-native";
// eslint-disable-next-line no-restricted-imports -- plugin bundles receive TanStack's real runtime, not Paseo's query wrappers.
import * as ReactQuery from "@tanstack/react-query";
import * as Zod from "zod";
import {
  defineAttachmentSource,
  defineRpc,
  type PluginAttachmentSourceContribution,
  type PluginCommandCenterItemContribution,
  type PluginSidebarContribution,
  type PluginSurfaceProps,
  type PluginWorkspacePanelContribution,
  usePaseo,
  useAgent,
  useWorkspace,
  useRpc,
} from "@paseo/plugin";
import { createPluginContext, type PluginRegistrationCollector } from "@paseo/plugin/host";
import type { EvaluatedPlugin } from "./types";
import type { ComponentType } from "react";
import { resolvePluginIcon } from "./icons";

const CONTRIBUTION_ID = /^[a-z][a-z0-9-]*$/;

function requireId(value: string, label: string): string {
  const id = value.trim();
  if (!CONTRIBUTION_ID.test(id)) throw new Error(`Invalid ${label}: ${value}`);
  return id;
}

export function evaluatePluginClientBundle(id: string, bundle: string): EvaluatedPlugin {
  const collector: PluginRegistrationCollector = {
    surfaces: [],
    sidebarItems: [],
    workspacePanels: [],
    commandCenterItems: [],
    attachmentSources: [],
  };
  const surfaceIds = new Set<string>();
  const sidebarItemIds = new Set<string>();
  const workspacePanelIds = new Set<string>();
  const commandCenterItemIds = new Set<string>();
  const attachmentSourceIds = new Set<string>();
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
    addWorkspacePanel(contribution: PluginWorkspacePanelContribution) {
      const normalizedId = requireId(contribution.id, "workspace panel id");
      if (workspacePanelIds.has(normalizedId)) {
        throw new Error(`Duplicate workspace panel: ${normalizedId}`);
      }
      const title = contribution.title.trim();
      const icon = contribution.icon.trim();
      if (!title) throw new Error(`Workspace panel ${normalizedId} has no title`);
      if (!icon) throw new Error(`Workspace panel ${normalizedId} has no icon`);
      if (contribution.context !== "workspace" && contribution.context !== "agent") {
        throw new Error(`Workspace panel ${normalizedId} has invalid context`);
      }
      if (typeof contribution.Component !== "function") {
        throw new Error(`Workspace panel ${normalizedId} is not a component`);
      }
      resolvePluginIcon(icon);
      workspacePanelIds.add(normalizedId);
      collector.workspacePanels.push({ ...contribution, id: normalizedId, title, icon });
    },
    addCommandCenterItem(contribution: PluginCommandCenterItemContribution) {
      const normalizedId = requireId(contribution.id, "Command Center item id");
      if (commandCenterItemIds.has(normalizedId)) {
        throw new Error(`Duplicate Command Center item: ${normalizedId}`);
      }
      const title = contribution.title.trim();
      const icon = contribution.icon.trim();
      if (!title) throw new Error(`Command Center item ${normalizedId} has no title`);
      if (!icon) throw new Error(`Command Center item ${normalizedId} has no icon`);
      if (
        contribution.context !== "global" &&
        contribution.context !== "workspace" &&
        contribution.context !== "agent"
      ) {
        throw new Error(`Command Center item ${normalizedId} has invalid context`);
      }
      if (typeof contribution.onSelect !== "function") {
        throw new Error(`Command Center item ${normalizedId} has no callback`);
      }
      resolvePluginIcon(icon);
      commandCenterItemIds.add(normalizedId);
      collector.commandCenterItems.push({
        ...contribution,
        id: normalizedId,
        title,
        icon,
        keywords: contribution.keywords?.map((keyword) => keyword.trim()).filter(Boolean),
      });
    },
    addAttachmentSource(contribution: PluginAttachmentSourceContribution) {
      const normalizedId = requireId(contribution.id, "attachment source id");
      if (attachmentSourceIds.has(normalizedId)) {
        throw new Error(`Duplicate attachment source: ${normalizedId}`);
      }
      const title = contribution.title.trim();
      const icon = contribution.icon.trim();
      const pickerTitle = contribution.pickerTitle.trim();
      const searchPlaceholder = contribution.searchPlaceholder.trim();
      const method = contribution.search.name.trim();
      if (!title) throw new Error(`Attachment source ${normalizedId} has no title`);
      if (!icon) throw new Error(`Attachment source ${normalizedId} has no icon`);
      if (!pickerTitle) throw new Error(`Attachment source ${normalizedId} has no picker title`);
      if (!searchPlaceholder) {
        throw new Error(`Attachment source ${normalizedId} has no search placeholder`);
      }
      if (!method) throw new Error(`Attachment source ${normalizedId} has no search RPC`);
      resolvePluginIcon(icon);
      attachmentSourceIds.add(normalizedId);
      collector.attachmentSources.push({
        id: normalizedId,
        title,
        icon,
        pickerTitle,
        searchPlaceholder,
        search: { ...contribution.search, name: method },
      });
    },
  });
  const runtimeRequire = (name: string): unknown => {
    if (name === "react") return React;
    if (name === "react/jsx-runtime") return ReactJsxRuntime;
    if (name === "react-native") return ReactNative;
    if (name === "@paseo/plugin") {
      return {
        defineAttachmentSource,
        defineRpc,
        usePaseo,
        useAgent,
        useWorkspace,
        useRpc,
      };
    }
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
  const cleanup = setup(pluginContext);
  if (typeof cleanup !== "function") {
    throw new Error(`Plugin ${id} contribution must return a cleanup function`);
  }

  try {
    for (const item of collector.sidebarItems) {
      if (!surfaceIds.has(item.surface)) {
        throw new Error(`Sidebar item ${item.id} references missing surface ${item.surface}`);
      }
    }
  } catch (error) {
    try {
      void Promise.resolve(cleanup()).catch((cleanupError) => {
        console.warn(`[Plugins] Cleanup failed after setup error for ${id}`, cleanupError);
      });
    } catch (cleanupError) {
      console.warn(`[Plugins] Cleanup failed after setup error for ${id}`, cleanupError);
    }
    throw error;
  }
  return {
    id,
    cleanup,
    surfaces: collector.surfaces,
    sidebarItems: collector.sidebarItems,
    workspacePanels: collector.workspacePanels,
    commandCenterItems: collector.commandCenterItems,
    attachmentSources: collector.attachmentSources,
  };
}

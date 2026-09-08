import * as pluginUiRuntime from "./react-native/ui";
import { useSettings } from "./settings/use-settings";
import * as pluginSharedRuntime from "@getpaseo/plugin";
import * as pluginClientRuntime from "@getpaseo/plugin/client";
import * as React from "react";
import * as ReactJsxRuntime from "react/jsx-runtime";
// eslint-disable-next-line no-restricted-imports -- plugin client runtime injects host ReactNative.
import * as ReactNative from "react-native";
// eslint-disable-next-line no-restricted-imports -- plugin bundles receive TanStack's real runtime, not Paseo's query wrappers.
import * as ReactQuery from "@tanstack/react-query";
import * as Zod from "zod";
import {
  type PluginAttachmentSourceContribution,
  type PluginCleanup,
  type PluginThemeContribution,
} from "@getpaseo/plugin";
import {
  type PluginCommandCenterItemContribution,
  type PluginClientContext,
  type PluginClientSlashCommandContribution,
  type PluginSidebarContribution,
  type PluginSurfaceProps,
  type PluginTimelineRendererContribution,
  type PluginTimelineTransformerContribution,
  type PluginWorkspacePanelContribution,
} from "@getpaseo/plugin/client";
import type { EvaluatedPlugin } from "./types";
import type { ComponentType } from "react";
import { resolvePluginIcon } from "./icons";
import { pluginReactNativeRuntime } from "./react-native/runtime";
import { parsePluginThemeContribution } from "./themes";

const CONTRIBUTION_ID = /^[a-z][a-z0-9-]*$/;
const PANEL_LOCATIONS = ["workspace", "explorer"] as const;
const TIMELINE_ITEM_TYPES = new Set([
  "user_message",
  "assistant_message",
  "reasoning",
  "tool_call",
  "todo",
  "error",
  "compaction",
]);

function normalizePanelLocations(
  panelId: string,
  locations: PluginWorkspacePanelContribution["locations"],
): readonly (typeof PANEL_LOCATIONS)[number][] {
  if (locations === undefined) return ["workspace"];
  if (!Array.isArray(locations) || locations.length === 0) {
    throw new Error(`Workspace panel ${panelId} must support at least one location`);
  }
  const normalized = locations.map((location) => {
    if (!PANEL_LOCATIONS.includes(location as never)) {
      throw new Error(`Workspace panel ${panelId} has invalid location: ${String(location)}`);
    }
    return location;
  });
  if (new Set(normalized).size !== normalized.length) {
    throw new Error(`Workspace panel ${panelId} has duplicate locations`);
  }
  return normalized;
}

function requireId(value: string, label: string): string {
  const id = value.trim();
  if (!CONTRIBUTION_ID.test(id)) throw new Error(`Invalid ${label}: ${value}`);
  return id;
}

export type PluginClientRuntime = Pick<
  PluginClientContext,
  "paseo" | "rpc" | "openSettings" | "openSurface" | "openPanel" | "addComposerPill"
>;

export function runPluginClientBundle(
  id: string,
  bundle: string,
  runtime: PluginClientRuntime,
  onChange: () => void = () => undefined,
): EvaluatedPlugin {
  const collector: Omit<EvaluatedPlugin, "id" | "cleanup"> = {
    surfaces: [],
    settingsScreens: [],
    sidebarItems: [],
    workspacePanels: [],
    commandCenterItems: [],
    clientSlashCommands: [],
    attachmentSources: [],
    themes: [],
    timelineTransformers: [],
    timelineRenderers: [],
  };
  const surfaceIds = new Set<string>();
  const settingsScreenIds = new Set<string>();
  const sidebarItemIds = new Set<string>();
  const workspacePanelIds = new Set<string>();
  const commandCenterItemIds = new Set<string>();
  const clientSlashCommandNames = new Set<string>();
  const attachmentSourceIds = new Set<string>();
  const themeIds = new Set<string>();
  const timelineTransformerIds = new Set<string>();
  const timelineRendererIds = new Set<string>();
  const removals = new Set<PluginCleanup>();
  let setupComplete = false;
  const notifyChange = () => {
    if (setupComplete) onChange();
  };
  function register<T>(items: T[], item: T, release: () => void): PluginCleanup {
    items.push(item);
    notifyChange();
    let active = true;
    const remove = () => {
      if (!active) return;
      active = false;
      const index = items.indexOf(item);
      if (index !== -1) items.splice(index, 1);
      release();
      removals.delete(remove);
      notifyChange();
    };
    removals.add(remove);
    return remove;
  }
  const pluginContext: PluginClientContext = {
    ...runtime,
    addSettingsScreen(contribution) {
      const screenId = requireId(contribution.id, "settings screen id");
      if (settingsScreenIds.has(screenId))
        throw new Error(`Duplicate settings screen: ${screenId}`);
      if (!contribution.title.trim()) throw new Error(`Invalid settings screen: ${screenId}`);
      resolvePluginIcon(contribution.icon);
      settingsScreenIds.add(screenId);
      return register(collector.settingsScreens, { ...contribution, id: screenId }, () =>
        settingsScreenIds.delete(screenId),
      );
    },
    addSurface(surfaceId: string, Component: ComponentType<PluginSurfaceProps>) {
      const normalizedId = requireId(surfaceId, "surface id");
      if (surfaceIds.has(normalizedId)) throw new Error(`Duplicate surface: ${normalizedId}`);
      if (typeof Component !== "function")
        throw new Error(`Surface ${normalizedId} is not a component`);
      surfaceIds.add(normalizedId);
      return register(collector.surfaces, { id: normalizedId, Component }, () =>
        surfaceIds.delete(normalizedId),
      );
    },
    addSidebarItem(contribution: PluginSidebarContribution) {
      const normalizedId = requireId(contribution.id, "sidebar item id");
      if (sidebarItemIds.has(normalizedId))
        throw new Error(`Duplicate sidebar item: ${normalizedId}`);
      if (!contribution.title.trim()) throw new Error(`Sidebar item ${normalizedId} has no title`);
      if (!contribution.icon.trim()) throw new Error(`Sidebar item ${normalizedId} has no icon`);
      resolvePluginIcon(contribution.icon.trim());
      sidebarItemIds.add(normalizedId);
      return register(
        collector.sidebarItems,
        {
          id: normalizedId,
          title: contribution.title.trim(),
          icon: contribution.icon.trim(),
          surface: requireId(contribution.surface, "sidebar surface id"),
        },
        () => sidebarItemIds.delete(normalizedId),
      );
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
      const locations = normalizePanelLocations(normalizedId, contribution.locations);
      workspacePanelIds.add(normalizedId);
      return register(
        collector.workspacePanels,
        {
          ...contribution,
          id: normalizedId,
          title,
          icon,
          locations,
        },
        () => workspacePanelIds.delete(normalizedId),
      );
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
      return register(
        collector.commandCenterItems,
        {
          ...contribution,
          id: normalizedId,
          title,
          icon,
          keywords: contribution.keywords?.map((keyword) => keyword.trim()).filter(Boolean),
        },
        () => commandCenterItemIds.delete(normalizedId),
      );
    },
    addSlashCommand(contribution: PluginClientSlashCommandContribution) {
      const name = requireId(contribution.name, "client slash command name");
      if (clientSlashCommandNames.has(name)) {
        throw new Error(`Duplicate client slash command: ${name}`);
      }
      const description = contribution.description.trim();
      if (!description) throw new Error(`Client slash command ${name} has no description`);
      if (contribution.context !== "workspace" && contribution.context !== "agent") {
        throw new Error(`Client slash command ${name} has invalid context`);
      }
      if (typeof contribution.onSubmit !== "function") {
        throw new Error(`Client slash command ${name} has no callback`);
      }
      clientSlashCommandNames.add(name);
      return register(
        collector.clientSlashCommands,
        {
          ...contribution,
          name,
          description,
          argumentHint: contribution.argumentHint.trim(),
        },
        () => clientSlashCommandNames.delete(name),
      );
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
      return register(
        collector.attachmentSources,
        {
          id: normalizedId,
          title,
          icon,
          pickerTitle,
          searchPlaceholder,
          search: { ...contribution.search, name: method },
        },
        () => attachmentSourceIds.delete(normalizedId),
      );
    },
    addTheme(contribution: PluginThemeContribution) {
      const normalizedId = requireId(contribution.id, "theme id");
      if (themeIds.has(normalizedId)) throw new Error(`Duplicate theme: ${normalizedId}`);
      const theme = parsePluginThemeContribution({ ...contribution, id: normalizedId });
      themeIds.add(normalizedId);
      return register(collector.themes, theme, () => themeIds.delete(normalizedId));
    },
    addTimelineTransformer(contribution: PluginTimelineTransformerContribution) {
      const normalizedId = requireId(contribution.id, "timeline transformer id");
      if (timelineTransformerIds.has(normalizedId)) {
        throw new Error(`Duplicate timeline transformer: ${normalizedId}`);
      }
      if (!contribution.query || typeof contribution.query.itemType !== "string") {
        throw new Error(`Timeline transformer ${normalizedId} has no item type`);
      }
      if (!TIMELINE_ITEM_TYPES.has(contribution.query.itemType)) {
        throw new Error(
          `Timeline transformer ${normalizedId} has invalid item type: ${contribution.query.itemType}`,
        );
      }
      if (typeof contribution.transform !== "function") {
        throw new Error(`Timeline transformer ${normalizedId} has no transform`);
      }
      if (contribution.id !== normalizedId) {
        throw new Error(`Invalid timeline transformer id: ${contribution.id}`);
      }
      timelineTransformerIds.add(normalizedId);
      return register(collector.timelineTransformers, contribution, () =>
        timelineTransformerIds.delete(normalizedId),
      );
    },
    addTimelineRenderer(contribution: PluginTimelineRendererContribution) {
      const kind = requireId(contribution.kind, "timeline renderer kind");
      if (!Number.isInteger(contribution.version) || contribution.version < 1) {
        throw new Error(`Timeline renderer ${kind} has invalid version`);
      }
      const rendererId = `${kind}/${contribution.version}`;
      if (timelineRendererIds.has(rendererId)) {
        throw new Error(`Duplicate timeline renderer: ${rendererId}`);
      }
      if (!contribution.schema || typeof contribution.schema.safeParse !== "function") {
        throw new Error(`Timeline renderer ${rendererId} has no schema`);
      }
      if (typeof contribution.Component !== "function") {
        throw new Error(`Timeline renderer ${rendererId} is not a component`);
      }
      timelineRendererIds.add(rendererId);
      return register(collector.timelineRenderers, { ...contribution, kind }, () =>
        timelineRendererIds.delete(rendererId),
      );
    },
    addComposerPill(contribution) {
      const removePill = runtime.addComposerPill(contribution);
      let active = true;
      const remove = () => {
        if (!active) return;
        active = false;
        removePill();
        removals.delete(remove);
      };
      removals.add(remove);
      return remove;
    },
  };
  const runtimeRequire = (name: string): unknown => {
    if (name === "@getpaseo/plugin/client/ui") return pluginUiRuntime;
    if (name === "react") return React;
    if (name === "react/jsx-runtime") return ReactJsxRuntime;
    if (name === "react-native") return ReactNative;
    if (name === "@getpaseo/plugin") return pluginSharedRuntime;
    if (name === "@getpaseo/plugin/client") return { ...pluginClientRuntime, useSettings };
    if (name === "@getpaseo/plugin/client/react-native") {
      return pluginReactNativeRuntime;
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
  const entryCleanup = setup(pluginContext);
  if (typeof entryCleanup !== "function") {
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
      void Promise.resolve(entryCleanup()).catch((cleanupError) => {
        console.warn(`[Plugins] Cleanup failed after setup error for ${id}`, cleanupError);
      });
    } catch (cleanupError) {
      console.warn(`[Plugins] Cleanup failed after setup error for ${id}`, cleanupError);
    }
    throw error;
  }
  setupComplete = true;
  let stopped = false;
  const cleanup = async () => {
    if (stopped) return;
    stopped = true;
    try {
      await entryCleanup();
    } finally {
      for (const remove of removals) remove();
    }
  };
  return {
    id,
    cleanup,
    surfaces: collector.surfaces,
    settingsScreens: collector.settingsScreens,
    sidebarItems: collector.sidebarItems,
    workspacePanels: collector.workspacePanels as EvaluatedPlugin["workspacePanels"],
    commandCenterItems: collector.commandCenterItems,
    clientSlashCommands: collector.clientSlashCommands,
    attachmentSources: collector.attachmentSources,
    themes: collector.themes,
    timelineTransformers: collector.timelineTransformers,
    timelineRenderers: collector.timelineRenderers,
  };
}

import * as React from "react";
import * as ReactJsxRuntime from "react/jsx-runtime";
// eslint-disable-next-line no-restricted-imports -- plugin client runtime injects host ReactNative.
import * as ReactNative from "react-native";
// eslint-disable-next-line no-restricted-imports -- plugin bundles receive TanStack's real runtime, not Paseo's query wrappers.
import * as ReactQuery from "@tanstack/react-query";
import * as Zod from "zod";
import {
  PluginAttachmentItemSchema,
  PluginAttachmentSearchPayloadSchema,
  defineAttachmentSource,
  defineForgeClientProvider,
  defineForgeFacts,
  defineRpc,
  type PluginAttachmentSourceContribution,
  type PluginCommandCenterItemContribution,
  type PluginCleanup,
  type PluginClientContext,
  type PluginClientSlashCommandContribution,
  type PluginForgeClientProviderContribution,
  type PluginSidebarContribution,
  type PluginSurfaceProps,
  type PluginThemeContribution,
  type PluginTimelineRendererContribution,
  type PluginTimelineTransformerContribution,
  type PluginWorkspacePanelContribution,
  useAgent,
  usePaseo,
  useRpc,
  useWorkspace,
} from "@getpaseo/plugin";
import { normalizeHost } from "@getpaseo/protocol/git-remote";
import type { EvaluatedPlugin } from "./types";
import type { ComponentType } from "react";
import { Icon, resolvePluginIcon } from "./icons";
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
const FORGE_ID = /^[a-z0-9][a-z0-9._-]*$/;
const FORGE_COLOR = /^(?:#[0-9a-f]{6}|#[0-9a-f]{8})$/i;
const MAX_FORGE_ICON_PATH_LENGTH = 16_384;

const PLUGIN_CLIENT_RUNTIME = {
  PluginAttachmentItemSchema,
  PluginAttachmentSearchPayloadSchema,
  defineAttachmentSource,
  defineForgeClientProvider,
  defineForgeFacts,
  defineRpc,
  Icon,
  useAgent,
  usePaseo,
  useRpc,
  useWorkspace,
};

function requireId(value: string, label: string): string {
  const id = value.trim();
  if (!CONTRIBUTION_ID.test(id)) throw new Error(`Invalid ${label}: ${value}`);
  return id;
}

function requireForgeId(value: string, label: string): string {
  const id = value.trim();
  if (!FORGE_ID.test(id)) throw new Error(`Invalid ${label}: ${value}`);
  return id;
}

function requireForgeText(value: string, providerId: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`Forge provider ${providerId} has no ${label}`);
  }
  return normalized;
}

function normalizeForgeDefinition(
  contribution: PluginForgeClientProviderContribution,
): PluginForgeClientProviderContribution["definition"] {
  const definition = contribution.definition;
  const id = requireForgeId(definition.id, "Forge provider id");
  const signIn = definition.signIn
    ? {
        cli: definition.signIn.cli.trim(),
        command: definition.signIn.command.trim(),
        hostnameFlag: definition.signIn.hostnameFlag?.trim() || undefined,
      }
    : null;
  if (signIn && (!signIn.cli || !signIn.command)) {
    throw new Error(`Forge provider ${id} has an invalid sign-in recipe`);
  }
  const cloudHosts = definition.cloudHosts?.map(normalizeHost);
  if (cloudHosts?.some((host) => !host)) {
    throw new Error(`Forge provider ${id} has an empty cloud host`);
  }
  if (cloudHosts && new Set(cloudHosts).size !== cloudHosts.length) {
    throw new Error(`Forge provider ${id} has duplicate cloud hosts`);
  }
  return {
    ...definition,
    id,
    displayName: requireForgeText(definition.displayName, id, "display name"),
    changeRequestAbbrev: requireForgeText(
      definition.changeRequestAbbrev,
      id,
      "change-request abbreviation",
    ),
    changeRequestNoun: requireForgeText(definition.changeRequestNoun, id, "change-request noun"),
    changeRequestNumberPrefix: requireForgeText(
      definition.changeRequestNumberPrefix,
      id,
      "change-request number prefix",
    ),
    issueNumberPrefix: requireForgeText(definition.issueNumberPrefix, id, "issue number prefix"),
    signIn,
    cloudHosts,
  };
}

function normalizeForgeFacts(
  contribution: PluginForgeClientProviderContribution,
  providerId: string,
): PluginForgeClientProviderContribution["facts"] {
  const facts = contribution.facts;
  if (!facts) return undefined;
  const family = requireForgeId(facts.family, "Forge facts family");
  if (typeof facts.schema?.safeParse !== "function") {
    throw new Error(`Forge provider ${providerId} has no valid facts schema`);
  }
  if (
    facts.deriveMergeCapability !== undefined &&
    typeof facts.deriveMergeCapability !== "function"
  ) {
    throw new Error(`Forge provider ${providerId} has an invalid merge capability callback`);
  }
  return { ...facts, family };
}

function validateForgeUrlGrammar(
  contribution: PluginForgeClientProviderContribution,
  providerId: string,
): void {
  const grammar = contribution.urlGrammar;
  if (!grammar) return;
  if (!grammar.treeInfix.startsWith("/")) {
    throw new Error(`Forge provider ${providerId} tree URL infix must start with /`);
  }
  if (!grammar.blobInfix.startsWith("/")) {
    throw new Error(`Forge provider ${providerId} blob URL infix must start with /`);
  }
  if (grammar.changeRequestChecksSuffix && !grammar.changeRequestChecksSuffix.startsWith("/")) {
    throw new Error(`Forge provider ${providerId} checks URL suffix must start with /`);
  }
  for (const referencePath of grammar.referencePaths ?? []) {
    if (referencePath.kind !== "change_request" && referencePath.kind !== "issue") {
      throw new Error(`Forge provider ${providerId} has an invalid reference path kind`);
    }
    if (!referencePath.infix.startsWith("/") || !referencePath.infix.endsWith("/")) {
      throw new Error(
        `Forge provider ${providerId} reference path infix must start and end with /`,
      );
    }
  }
}

function validateForgeView(
  contribution: PluginForgeClientProviderContribution,
  providerId: string,
): void {
  const view = contribution.view;
  if (!view) return;
  const { icon, brandColor } = view;
  const validIcon =
    icon.kind === "svg-path" &&
    icon.viewBox.length === 4 &&
    icon.viewBox.every(Number.isFinite) &&
    icon.viewBox[2] > 0 &&
    icon.viewBox[3] > 0 &&
    icon.path.trim().length > 0 &&
    icon.path.length <= MAX_FORGE_ICON_PATH_LENGTH;
  if (!validIcon) {
    throw new Error(`Forge provider ${providerId} has an invalid SVG path icon`);
  }
  if (brandColor && (!FORGE_COLOR.test(brandColor.light) || !FORGE_COLOR.test(brandColor.dark))) {
    throw new Error(`Forge provider ${providerId} has invalid brand colors`);
  }
}

function normalizeForgeClientProvider(
  contribution: PluginForgeClientProviderContribution,
): PluginForgeClientProviderContribution {
  const definition = normalizeForgeDefinition(contribution);
  const facts = normalizeForgeFacts(contribution, definition.id);
  validateForgeUrlGrammar(contribution, definition.id);
  validateForgeView(contribution, definition.id);
  return { ...contribution, definition, ...(facts ? { facts } : {}) };
}

export type PluginClientRuntime = Pick<
  PluginClientContext,
  "paseo" | "rpc" | "openSurface" | "openPanel" | "addComposerPill"
>;

export function runPluginClientBundle(
  id: string,
  bundle: string,
  runtime: PluginClientRuntime,
  onChange: () => void = () => undefined,
): EvaluatedPlugin {
  const collector: Omit<EvaluatedPlugin, "id" | "cleanup"> = {
    surfaces: [],
    sidebarItems: [],
    workspacePanels: [],
    commandCenterItems: [],
    clientSlashCommands: [],
    attachmentSources: [],
    themes: [],
    timelineTransformers: [],
    timelineRenderers: [],
    forgeClientProviders: [],
  };
  const surfaceIds = new Set<string>();
  const sidebarItemIds = new Set<string>();
  const workspacePanelIds = new Set<string>();
  const commandCenterItemIds = new Set<string>();
  const clientSlashCommandNames = new Set<string>();
  const attachmentSourceIds = new Set<string>();
  const themeIds = new Set<string>();
  const timelineTransformerIds = new Set<string>();
  const timelineRendererIds = new Set<string>();
  const forgeProviderIds = new Set<string>();
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
    addForgeClientProvider(contribution: PluginForgeClientProviderContribution) {
      const normalized = normalizeForgeClientProvider(contribution);
      const providerId = normalized.definition.id;
      if (forgeProviderIds.has(providerId)) {
        throw new Error(`Duplicate Forge provider: ${providerId}`);
      }
      forgeProviderIds.add(providerId);
      return register(collector.forgeClientProviders, normalized, () =>
        forgeProviderIds.delete(providerId),
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
    if (name === "react") return React;
    if (name === "react/jsx-runtime") return ReactJsxRuntime;
    if (name === "react-native") return ReactNative;
    if (name === "@getpaseo/plugin" || name === "@paseo/plugin") {
      // COMPAT(plugin-sdk-scope): @paseo/plugin was scaffolded through
      // 0.5.0-beta.1; remove this alias after 2026-11-19.
      return PLUGIN_CLIENT_RUNTIME;
    }
    if (name === "@getpaseo/plugin/react-native" || name === "@paseo/plugin/react-native") {
      return pluginReactNativeRuntime;
    }
    if (name === "@getpaseo/plugin/server" || name === "@paseo/plugin/server") {
      return {};
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
    sidebarItems: collector.sidebarItems,
    workspacePanels: collector.workspacePanels as EvaluatedPlugin["workspacePanels"],
    commandCenterItems: collector.commandCenterItems,
    clientSlashCommands: collector.clientSlashCommands,
    attachmentSources: collector.attachmentSources,
    themes: collector.themes,
    timelineTransformers: collector.timelineTransformers,
    timelineRenderers: collector.timelineRenderers,
    forgeClientProviders: collector.forgeClientProviders,
  };
}

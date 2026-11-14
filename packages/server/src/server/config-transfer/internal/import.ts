import { isDeepStrictEqual } from "node:util";
import { settingsRpc } from "@getpaseo/plugin";
import {
  PluginInstallationSchema,
  type HostConfigDocument,
  type MutableDaemonConfig,
  type MutableDaemonConfigPatch,
  type PluginListItem,
} from "@getpaseo/protocol/messages";
import { pluginInstallSource } from "@getpaseo/protocol/plugin-source-reference";
import type { PersistedConfig } from "../../persisted-config.js";
import {
  CONFIG_SECTIONS,
  sectionForPath,
  type RedactedPath,
  type SectionApply,
} from "./sections.js";

export interface SectionPreview {
  id: string;
  status: "ready" | "invalid" | "unchanged";
  changes: string[];
  issues: string[];
}

export interface PluginPreview {
  id: string;
  status: "install" | "already-installed" | "manual" | "invalid";
  source?: string;
  reason?: string;
}

export interface ImportPreview {
  sections: SectionPreview[];
  plugins: PluginPreview[];
  requiresPluginsEnabled: boolean;
  pluginsStartedByEnabling: string[];
}

export interface ImportResult {
  item: string;
  outcome: "applied" | "skipped" | "failed";
  reason?: string;
}

export interface ImportTarget {
  persisted: PersistedConfig;
  live: MutableDaemonConfig;
}

export interface ImportPorts {
  readTarget(): Promise<ImportTarget>;
  patch(patch: MutableDaemonConfigPatch): Promise<unknown>;
  saveSkillSelection(
    selection: Extract<SectionApply, { kind: "skills" }>["selection"],
  ): Promise<{ confirmationRequired: { removals: string[] } | null }>;
  installPlugin(input: { source: string; id: string; ref?: string }): Promise<PluginListItem>;
  disablePlugin(id: string): Promise<unknown>;
  invokePluginRpc(pluginId: string, method: string, input: unknown): Promise<unknown>;
}

export interface ApplyRequest {
  document: HostConfigDocument;
  sections: readonly string[];
  plugins: readonly string[];
  enablePlugins: boolean;
}

function assertSupportedDocument(document: HostConfigDocument): void {
  if (document.version !== 1) {
    throw new Error(
      `Host config document version ${document.version} is newer than this daemon understands (1); update this host`,
    );
  }
}

function previewSections(document: HostConfigDocument, target: PersistedConfig): SectionPreview[] {
  return Object.entries(document.config).map(([id, value]) => {
    const section = CONFIG_SECTIONS.find((candidate) => candidate.id === id);
    if (!section) {
      return {
        id,
        status: "invalid",
        changes: [],
        issues: [`${id}: this daemon has no "${id}" settings`],
      };
    }
    const validated = section.validate(value);
    if (!validated.ok) return { id, status: "invalid", changes: [], issues: validated.issues };
    const current = section.read(target, []);
    const changes = changedKeys(current, value);
    return { id, status: changes.length === 0 ? "unchanged" : "ready", changes, issues: [] };
  });
}

function changedKeys(current: unknown, incoming: unknown): string[] {
  if (isDeepStrictEqual(current, incoming)) return [];
  if (!isRecord(incoming) || (current !== undefined && !isRecord(current))) return ["(all)"];
  const before = current ?? {};
  return Object.keys(incoming).filter((key) => !isDeepStrictEqual(before[key], incoming[key]));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function previewPlugins(document: HostConfigDocument, live: MutableDaemonConfig): PluginPreview[] {
  const configured = live.plugins ?? {};
  return [
    ...document.plugins.map((plugin): PluginPreview => {
      const installation = PluginInstallationSchema.safeParse(plugin.installation);
      if (!installation.success) {
        return { id: plugin.id, status: "invalid", reason: "unrecognized plugin source" };
      }
      if (configured[plugin.id]) {
        return { id: plugin.id, status: "already-installed", reason: "already on this host" };
      }
      const install = pluginInstallSource(
        installation.data.identity,
        installation.data.currentRevision,
      );
      if (!install) {
        return { id: plugin.id, status: "manual", reason: "no portable source for this registry" };
      }
      return { id: plugin.id, status: "install", source: install.source };
    }),
    ...document.manualPlugins.map(
      (plugin): PluginPreview => ({ id: plugin.id, status: "manual", reason: plugin.reason }),
    ),
  ];
}

export async function previewImport(
  document: HostConfigDocument,
  ports: Pick<ImportPorts, "readTarget">,
): Promise<ImportPreview> {
  return buildPreview(document, await ports.readTarget());
}

function buildPreview(document: HostConfigDocument, target: ImportTarget): ImportPreview {
  assertSupportedDocument(document);
  const plugins = previewPlugins(document, target.live);
  const pluginsOff = target.live.pluginsEnabled !== true;
  return {
    sections: previewSections(document, target.persisted),
    plugins,
    requiresPluginsEnabled: pluginsOff && plugins.some((plugin) => plugin.status === "install"),
    pluginsStartedByEnabling: pluginsOff
      ? Object.entries(target.live.plugins ?? {})
          .filter(([, source]) => source.enabled !== false)
          .map(([id]) => id)
      : [],
  };
}

export async function applyImport(
  request: ApplyRequest,
  ports: ImportPorts,
): Promise<{ results: ImportResult[]; reenter: RedactedPath[] }> {
  const target = await ports.readTarget();
  const preview = buildPreview(request.document, target);
  const results: ImportResult[] = [];

  const chosen = request.sections.map((id) => {
    const section = preview.sections.find((candidate) => candidate.id === id);
    if (!section) throw new Error(`Section "${id}" is not in this host config document`);
    return section;
  });
  const invalid = chosen.filter((section) => section.status === "invalid");
  if (invalid.length > 0) {
    throw new Error(
      `Cannot apply invalid sections: ${invalid.flatMap((section) => section.issues).join("; ")}`,
    );
  }

  const patch: MutableDaemonConfigPatch = {};
  const patchedSections: string[] = [];
  for (const section of chosen) {
    if (section.status === "unchanged") {
      results.push({ item: `section:${section.id}`, outcome: "skipped", reason: "unchanged" });
      continue;
    }
    const definition = CONFIG_SECTIONS.find((candidate) => candidate.id === section.id);
    const validated = definition?.validate(request.document.config[section.id]);
    if (!validated?.ok) throw new Error(`Section "${section.id}" failed validation`);
    if (validated.apply.kind === "skills") {
      const saved = await ports.saveSkillSelection(validated.apply.selection);
      results.push(
        saved.confirmationRequired
          ? {
              item: "section:skills",
              outcome: "failed",
              reason: `would remove skills ${saved.confirmationRequired.removals.join(", ")}; change the selection in Agents settings`,
            }
          : { item: "section:skills", outcome: "applied" },
      );
      continue;
    }
    Object.assign(patch, validated.apply.patch);
    patchedSections.push(section.id);
  }
  if (patchedSections.length > 0) {
    await ports.patch(patch);
    for (const id of patchedSections) results.push({ item: `section:${id}`, outcome: "applied" });
  }

  let pluginsOn = target.live.pluginsEnabled === true;
  if (request.enablePlugins && !pluginsOn) {
    await ports.patch({ pluginsEnabled: true });
    results.push({ item: "pluginsEnabled", outcome: "applied" });
    pluginsOn = true;
  }

  for (const pluginId of request.plugins) {
    results.push(...(await importPlugin({ pluginId, pluginsOn, preview, request, ports })));
  }

  const appliedSections = new Set(
    results
      .filter((result) => result.outcome === "applied" && result.item.startsWith("section:"))
      .map((result) => result.item.slice("section:".length)),
  );
  const reenter = request.document.redacted.filter((entry) => {
    const section = sectionForPath(entry.path);
    return section === undefined || appliedSections.has(section.id);
  });
  return { results, reenter };
}

async function importPlugin(input: {
  pluginId: string;
  pluginsOn: boolean;
  preview: ImportPreview;
  request: ApplyRequest;
  ports: ImportPorts;
}): Promise<ImportResult[]> {
  const { pluginId, preview, request, ports } = input;
  const item = `plugin:${pluginId}`;
  const planned = preview.plugins.find((plugin) => plugin.id === pluginId);
  if (!planned) throw new Error(`Plugin "${pluginId}" is not in this host config document`);
  if (planned.status !== "install") {
    return [{ item, outcome: "skipped", reason: planned.reason ?? planned.status }];
  }
  if (!input.pluginsOn) {
    return [{ item, outcome: "skipped", reason: "plugins are turned off on this host" }];
  }
  const exported = request.document.plugins.find((plugin) => plugin.id === pluginId);
  const installation = PluginInstallationSchema.parse(exported?.installation);
  const install = pluginInstallSource(installation.identity, installation.currentRevision);
  if (!install) throw new Error(`Plugin "${pluginId}" has no portable source`);

  try {
    await ports.installPlugin({ ...install, id: pluginId });
  } catch (error) {
    return [{ item, outcome: "failed", reason: errorMessage(error) }];
  }
  const results: ImportResult[] = [{ item, outcome: "applied" }];

  for (const entry of request.document.pluginSettings.filter((s) => s.pluginId === pluginId)) {
    results.push(await restoreSettings({ pluginId, entry, ports }));
  }
  if (exported?.enabled === false) await ports.disablePlugin(pluginId);
  return results;
}

async function restoreSettings(input: {
  pluginId: string;
  entry: HostConfigDocument["pluginSettings"][number];
  ports: Pick<ImportPorts, "invokePluginRpc">;
}): Promise<ImportResult> {
  const { pluginId, entry, ports } = input;
  const item = `settings:${pluginId}/${entry.settingsId}`;
  const rpc = settingsRpc(entry.settingsId);
  try {
    const read = rpc.read.output.parse(await ports.invokePluginRpc(pluginId, rpc.read.name, {}));
    const written = rpc.write.output.parse(
      await ports.invokePluginRpc(pluginId, rpc.write.name, {
        revision: read.revision,
        values: entry.values,
      }),
    );
    return written.status === "saved"
      ? { item, outcome: "applied" }
      : { item, outcome: "failed", reason: written.error };
  } catch (error) {
    return { item, outcome: "failed", reason: errorMessage(error) };
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

import type {
  PaseoConfigRaw,
  PaseoMetadataGeneration,
  PaseoMetadataGenerationEntry,
  PaseoScriptEntryRaw,
} from "@getpaseo/protocol/messages";

export type LifecycleOriginalKind = "string" | "array" | "missing";

export const METADATA_PROMPT_KEYS = ["branchName", "commitMessage", "pullRequest"] as const;
export type MetadataPromptKey = (typeof METADATA_PROMPT_KEYS)[number];

export interface ProjectScriptDraft {
  id: string;
  name: string;
  commandText: string;
  commandOriginalKind: LifecycleOriginalKind;
  type: string;
  portText: string;
  rawEntry: PaseoScriptEntryRaw;
}

export interface ProjectAgentEnvVarDraft {
  id: string;
  key: string;
  value: string;
}

/** One `agentEnv` layer: a static set of variables, or a command that prints the environment. */
export type ProjectAgentEnvLayerDraft =
  | { id: string; kind: "static"; vars: ProjectAgentEnvVarDraft[] }
  | { id: string; kind: "command"; command: string };

export interface ProjectConfigDraft {
  setupText: string;
  setupOriginalKind: LifecycleOriginalKind;
  teardownText: string;
  teardownOriginalKind: LifecycleOriginalKind;
  // The agent environment (top-level `agentEnv`), as ordered layers.
  agentEnvLayers: ProjectAgentEnvLayerDraft[];
  // True when the committed `agentEnv` is a shape this form cannot represent (e.g. a non-string
  // value in a map). We render it read-only rather than rewriting the file into something the
  // user did not ask for — the config is already invalid and the daemon rejects it at launch.
  agentEnvUnsupported: boolean;
  scripts: ProjectScriptDraft[];
  metadataPrompts: Record<MetadataPromptKey, string>;
  metadataGenerationBase: PaseoMetadataGeneration | undefined;
}

interface LifecycleProjection {
  text: string;
  kind: LifecycleOriginalKind;
}

function projectLifecycle(value: unknown): LifecycleProjection {
  if (typeof value === "string") {
    return { text: value, kind: "string" };
  }
  if (Array.isArray(value)) {
    const lines = value.filter((entry): entry is string => typeof entry === "string");
    return { text: lines.join("\n"), kind: "array" };
  }
  return { text: "", kind: "missing" };
}

function lifecycleFromText(
  text: string,
  kind: LifecycleOriginalKind,
): string | string[] | undefined {
  const lines = text.split("\n").filter((line) => line.trim().length > 0);
  if (lines.length === 0) {
    return undefined;
  }
  if (kind === "string") {
    return lines.join("\n");
  }
  if (kind === "array") {
    return lines;
  }
  return lines.length === 1 ? lines[0] : lines;
}

function projectScriptType(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function projectScriptPort(value: unknown): string {
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  if (typeof value === "string") {
    return value;
  }
  return "";
}

function parseScriptPort(value: string): number | string | undefined {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  if (/^[0-9]+$/.test(trimmed)) {
    const parsed = Number(trimmed);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return trimmed;
}

let scriptDraftIdCounter = 0;

function nextScriptDraftId(): string {
  scriptDraftIdCounter += 1;
  return `script-draft-${scriptDraftIdCounter}`;
}

let agentEnvDraftIdCounter = 0;

export function nextAgentEnvDraftId(prefix: string): string {
  agentEnvDraftIdCounter += 1;
  return `agent-env-${prefix}-${agentEnvDraftIdCounter}`;
}

function isStaticVarMap(value: unknown): value is Record<string, string> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((entry) => typeof entry === "string")
  );
}

function staticLayerFromMap(map: Record<string, string>): ProjectAgentEnvLayerDraft {
  return {
    id: nextAgentEnvDraftId("layer"),
    kind: "static",
    vars: Object.entries(map).map(([key, value]) => ({
      id: nextAgentEnvDraftId("var"),
      key,
      value,
    })),
  };
}

interface AgentEnvProjection {
  layers: ProjectAgentEnvLayerDraft[];
  unsupported: boolean;
}

function projectAgentEnv(value: unknown): AgentEnvProjection {
  if (value === undefined) {
    return { layers: [], unsupported: false };
  }
  const entries = Array.isArray(value) ? value : [value];
  const layers: ProjectAgentEnvLayerDraft[] = [];
  for (const entry of entries) {
    if (typeof entry === "string") {
      layers.push({ id: nextAgentEnvDraftId("layer"), kind: "command", command: entry });
      continue;
    }
    if (isStaticVarMap(entry)) {
      layers.push(staticLayerFromMap(entry));
      continue;
    }
    // Something we can't round-trip. Bail out entirely rather than half-representing it.
    return { layers: [], unsupported: true };
  }
  return { layers, unsupported: false };
}

/** Serialize layers back to the narrowest shape: a bare string, a bare map, or a list. */
function agentEnvFromLayers(
  layers: ProjectAgentEnvLayerDraft[],
): string | Record<string, string> | (string | Record<string, string>)[] | undefined {
  const serialized: (string | Record<string, string>)[] = [];
  for (const layer of layers) {
    if (layer.kind === "command") {
      const command = layer.command.trim();
      if (command.length > 0) {
        serialized.push(command);
      }
      continue;
    }
    const vars: Record<string, string> = {};
    for (const entry of layer.vars) {
      const key = entry.key.trim();
      if (key.length > 0) {
        vars[key] = entry.value;
      }
    }
    if (Object.keys(vars).length > 0) {
      serialized.push(vars);
    }
  }
  if (serialized.length === 0) {
    return undefined;
  }
  return serialized.length === 1 ? serialized[0] : serialized;
}

function emptyMetadataPrompts(): Record<MetadataPromptKey, string> {
  return {
    branchName: "",
    commitMessage: "",
    pullRequest: "",
  };
}

export function configToDraft(config: PaseoConfigRaw | null | undefined): ProjectConfigDraft {
  const worktree = config?.worktree ?? {};
  const setup = projectLifecycle(worktree.setup);
  const teardown = projectLifecycle(worktree.teardown);
  const scripts: ProjectScriptDraft[] = [];

  const scriptsRecord = config?.scripts ?? {};
  for (const [name, entry] of Object.entries(scriptsRecord)) {
    const command = projectLifecycle(entry.command);
    scripts.push({
      id: nextScriptDraftId(),
      name,
      commandText: command.text,
      commandOriginalKind: command.kind,
      type: projectScriptType(entry.type),
      portText: projectScriptPort(entry.port),
      rawEntry: entry,
    });
  }

  const metadataGeneration = config?.metadataGeneration;
  const metadataPrompts = emptyMetadataPrompts();
  for (const key of METADATA_PROMPT_KEYS) {
    const instructions = metadataGeneration?.[key]?.instructions;
    if (typeof instructions === "string") {
      metadataPrompts[key] = instructions;
    }
  }

  const agentEnv = projectAgentEnv(config?.agentEnv);

  return {
    setupText: setup.text,
    setupOriginalKind: setup.kind,
    teardownText: teardown.text,
    teardownOriginalKind: teardown.kind,
    agentEnvLayers: agentEnv.layers,
    agentEnvUnsupported: agentEnv.unsupported,
    scripts,
    metadataPrompts,
    metadataGenerationBase: metadataGeneration,
  };
}

interface ApplyDraftInput {
  draft: ProjectConfigDraft;
  base: PaseoConfigRaw | null | undefined;
}

export function applyDraftToConfig(input: ApplyDraftInput): PaseoConfigRaw {
  const baseConfig = input.base ?? {};
  const baseWorktree = baseConfig.worktree ?? {};

  const nextWorktree: Record<string, unknown> = { ...baseWorktree };
  const nextSetup = lifecycleFromText(input.draft.setupText, input.draft.setupOriginalKind);
  if (nextSetup === undefined) {
    delete nextWorktree.setup;
  } else {
    nextWorktree.setup = nextSetup;
  }
  const nextTeardown = lifecycleFromText(
    input.draft.teardownText,
    input.draft.teardownOriginalKind,
  );
  if (nextTeardown === undefined) {
    delete nextWorktree.teardown;
  } else {
    nextWorktree.teardown = nextTeardown;
  }
  const nextScripts: Record<string, PaseoScriptEntryRaw> = {};
  for (const row of input.draft.scripts) {
    const trimmedName = row.name.trim();
    if (trimmedName.length === 0) {
      continue;
    }
    const baseEntry = row.rawEntry;
    const nextEntry: Record<string, unknown> = { ...baseEntry };
    const nextCommand = lifecycleFromText(row.commandText, row.commandOriginalKind);
    if (nextCommand === undefined) {
      delete nextEntry.command;
    } else {
      nextEntry.command = nextCommand;
    }
    const trimmedType = row.type.trim();
    if (trimmedType.length === 0) {
      delete nextEntry.type;
    } else {
      nextEntry.type = trimmedType;
    }
    const nextPort = parseScriptPort(row.portText);
    if (nextPort === undefined) {
      delete nextEntry.port;
    } else {
      nextEntry.port = nextPort;
    }
    nextScripts[trimmedName] = nextEntry as PaseoScriptEntryRaw;
  }

  const nextMetadataGeneration: Record<string, unknown> = {
    ...input.draft.metadataGenerationBase,
  };
  for (const key of METADATA_PROMPT_KEYS) {
    const text = input.draft.metadataPrompts[key];
    const baseEntry = input.draft.metadataGenerationBase?.[key] as
      | PaseoMetadataGenerationEntry
      | undefined;
    if (text.trim().length === 0) {
      if (baseEntry) {
        const nextEntry: Record<string, unknown> = { ...baseEntry };
        delete nextEntry.instructions;
        if (Object.keys(nextEntry).length === 0) {
          delete nextMetadataGeneration[key];
        } else {
          nextMetadataGeneration[key] = nextEntry;
        }
      } else {
        delete nextMetadataGeneration[key];
      }
    } else {
      nextMetadataGeneration[key] = { ...baseEntry, instructions: text };
    }
  }

  const result: Record<string, unknown> = { ...baseConfig };
  if (Object.keys(nextWorktree).length === 0) {
    delete result.worktree;
  } else {
    result.worktree = nextWorktree;
  }
  // An `agentEnv` the form can't represent is left exactly as committed — saving an unrelated
  // field must never rewrite it into something the user didn't ask for.
  if (!input.draft.agentEnvUnsupported) {
    const nextAgentEnv = agentEnvFromLayers(input.draft.agentEnvLayers);
    if (nextAgentEnv === undefined) {
      delete result.agentEnv;
    } else {
      result.agentEnv = nextAgentEnv;
    }
  }
  if (Object.keys(nextScripts).length === 0) {
    delete result.scripts;
  } else {
    result.scripts = nextScripts;
  }
  if (Object.keys(nextMetadataGeneration).length === 0) {
    delete result.metadataGeneration;
  } else {
    result.metadataGeneration = nextMetadataGeneration;
  }
  return result as PaseoConfigRaw;
}

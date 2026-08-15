import type {
  PaseoConfigRaw,
  PaseoMetadataGeneration,
  PaseoMetadataGenerationEntry,
  PaseoScriptEntryRaw,
} from "@getpaseo/protocol/messages";
import { PASEO_PLATFORMS, type PaseoPlatform } from "@getpaseo/protocol/paseo-config-schema";

export type LifecycleOriginalKind = "string" | "array" | "missing";
export type CommandFormat = "single" | "platform";

export interface PlatformCommandDraft {
  text: string;
  originalKind: LifecycleOriginalKind;
}

export type PlatformCommandDrafts = Record<PaseoPlatform, PlatformCommandDraft>;

export interface CommandDraft {
  format: CommandFormat;
  text: string;
  originalKind: LifecycleOriginalKind;
  platforms: PlatformCommandDrafts;
}

export const METADATA_PROMPT_KEYS = ["branchName", "commitMessage", "pullRequest"] as const;
export type MetadataPromptKey = (typeof METADATA_PROMPT_KEYS)[number];

export interface ProjectScriptDraft {
  id: string;
  name: string;
  command: CommandDraft;
  type: string;
  portText: string;
  rawEntry: PaseoScriptEntryRaw;
}

export interface ProjectConfigDraft {
  setup: CommandDraft;
  teardown: CommandDraft;
  scripts: ProjectScriptDraft[];
  metadataPrompts: Record<MetadataPromptKey, string>;
  metadataGenerationBase: PaseoMetadataGeneration | undefined;
}

interface LifecycleProjection {
  text: string;
  kind: LifecycleOriginalKind;
}

function emptyPlatformCommands(): PlatformCommandDrafts {
  return {
    linux: { text: "", originalKind: "missing" },
    darwin: { text: "", originalKind: "missing" },
    win32: { text: "", originalKind: "missing" },
  };
}

function emptyCommandDraft(): CommandDraft {
  return {
    format: "single",
    text: "",
    originalKind: "missing",
    platforms: emptyPlatformCommands(),
  };
}

export function createEmptyCommandDraft(): CommandDraft {
  return emptyCommandDraft();
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

function projectPlatformCommand(value: unknown): PlatformCommandDraft {
  const projection = projectLifecycle(value);
  return { text: projection.text, originalKind: projection.kind };
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function projectCommand(value: unknown): CommandDraft {
  if (isRecord(value)) {
    return {
      ...emptyCommandDraft(),
      format: "platform",
      platforms: {
        linux: projectPlatformCommand(value.linux),
        darwin: projectPlatformCommand(value.darwin),
        win32: projectPlatformCommand(value.win32),
      },
    };
  }

  const single = projectLifecycle(value);
  return {
    ...emptyCommandDraft(),
    text: single.text,
    originalKind: single.kind,
  };
}

function commandFromDraft(
  command: CommandDraft,
): string | string[] | PlatformCommandValues | undefined {
  if (command.format === "single") {
    return lifecycleFromText(command.text, command.originalKind);
  }

  const platformCommands: PlatformCommandValues = {};
  for (const platform of PASEO_PLATFORMS) {
    const value = lifecycleFromText(
      command.platforms[platform].text,
      command.platforms[platform].originalKind,
    );
    if (value !== undefined) {
      platformCommands[platform] = value;
    }
  }
  return Object.keys(platformCommands).length > 0 ? platformCommands : undefined;
}

type PlatformCommandValue = string | string[];
type PlatformCommandValues = Partial<Record<PaseoPlatform, PlatformCommandValue>>;

export function changeCommandFormat(command: CommandDraft, format: CommandFormat): CommandDraft {
  if (command.format === format) {
    return command;
  }

  if (format === "platform") {
    const platformCommand = {
      text: command.text,
      originalKind: command.originalKind,
    };
    return {
      ...command,
      format,
      platforms: {
        linux: { ...platformCommand },
        darwin: { ...platformCommand },
        win32: { ...platformCommand },
      },
    };
  }

  for (const platform of PASEO_PLATFORMS) {
    const platformCommand = command.platforms[platform];
    if (platformCommand.text.trim().length > 0) {
      return {
        ...command,
        format,
        text: platformCommand.text,
        originalKind: platformCommand.originalKind,
      };
    }
  }

  return {
    ...command,
    format,
    text: "",
    originalKind: "missing",
  };
}

export function hasCommandText(command: CommandDraft): boolean {
  if (command.format === "single") {
    return command.text.trim().length > 0;
  }
  return PASEO_PLATFORMS.some((platform) => command.platforms[platform].text.trim().length > 0);
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

function emptyMetadataPrompts(): Record<MetadataPromptKey, string> {
  return {
    branchName: "",
    commitMessage: "",
    pullRequest: "",
  };
}

export function configToDraft(config: PaseoConfigRaw | null | undefined): ProjectConfigDraft {
  const worktree = config?.worktree ?? {};
  const setup = projectCommand(worktree.setup);
  const teardown = projectCommand(worktree.teardown);
  const scripts: ProjectScriptDraft[] = [];

  const scriptsRecord = config?.scripts ?? {};
  for (const [name, entry] of Object.entries(scriptsRecord)) {
    const command = projectCommand(entry.command);
    scripts.push({
      id: nextScriptDraftId(),
      name,
      command,
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

  return {
    setup,
    teardown,
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
  const nextSetup = commandFromDraft(input.draft.setup);
  if (nextSetup === undefined) {
    delete nextWorktree.setup;
  } else {
    nextWorktree.setup = nextSetup;
  }
  const nextTeardown = commandFromDraft(input.draft.teardown);
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
    const nextCommand = commandFromDraft(row.command);
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

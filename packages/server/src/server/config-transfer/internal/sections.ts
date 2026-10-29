import path from "node:path";
import { z } from "zod";
import { AgentProfileSchema, AgentSkillSelectionSchema } from "@getpaseo/protocol/agent-profile";
import type { AgentSkillSelection, MutableDaemonConfigPatch } from "@getpaseo/protocol/messages";
import type { SpeechSettingsPatch } from "@getpaseo/protocol/speech/rpc-schemas";
import { TerminalProfileSchema } from "@getpaseo/protocol/terminal-profile";
import { ProviderOverrideSchema } from "../../agent/provider-launch-config.js";
import {
  AgentMetadataGenerationSchema,
  FeatureDictationSchema,
  FeatureVoiceModeSchema,
  type PersistedConfig,
} from "../../persisted-config.js";

export interface RedactedPath {
  path: string;
  kind: "secret" | "machine-path";
}

export type SectionApply =
  | { kind: "patch"; patch: MutableDaemonConfigPatch }
  | { kind: "skills"; selection: AgentSkillSelection };

export interface ConfigSection {
  id: string;
  /** config.json path prefixes this section owns; redactions under them belong to it. */
  paths: readonly string[];
  /** The portable value, or undefined when the user has not configured this section. */
  read(persisted: PersistedConfig, redacted: RedactedPath[]): unknown;
  validate(value: unknown): { ok: true; apply: SectionApply } | { ok: false; issues: string[] };
}

function defineSection<Schema extends z.ZodType>(definition: {
  id: string;
  paths: readonly string[];
  schema: Schema;
  read(persisted: PersistedConfig, redacted: RedactedPath[]): z.input<Schema> | undefined;
  toApply(value: z.output<Schema>): SectionApply;
}): ConfigSection {
  return {
    id: definition.id,
    paths: definition.paths,
    read: definition.read,
    validate(value) {
      const parsed = definition.schema.safeParse(value);
      if (!parsed.success) {
        return {
          ok: false,
          issues: parsed.error.issues.map(
            (issue) => `${[definition.id, ...issue.path].join(".")}: ${issue.message}`,
          ),
        };
      }
      return { ok: true, apply: definition.toApply(parsed.data) };
    },
  };
}

function isAbsoluteOnAnyPlatform(candidate: string): boolean {
  return path.posix.isAbsolute(candidate) || path.win32.isAbsolute(candidate);
}

function definedEntries<T extends Record<string, unknown>>(value: T): Partial<T> | undefined {
  const entries = Object.entries(value).filter(([, entry]) => entry !== undefined);
  return entries.length === 0 ? undefined : (Object.fromEntries(entries) as Partial<T>);
}

const SPEECH_SECRET_FIELDS = ["apiKey", "baseUrl"] as const;

// Both secret fields are optional on every site shape, so removing them keeps the site's type.
function stripSpeechSite<Site extends object>(
  site: Site | undefined,
  sitePath: string,
  redacted: RedactedPath[],
): Site | undefined {
  if (!site) return undefined;
  const portable = { ...site } as Record<string, unknown>;
  for (const field of SPEECH_SECRET_FIELDS) {
    if (portable[field] === undefined) continue;
    delete portable[field];
    redacted.push({ path: `${sitePath}.${field}`, kind: "secret" });
  }
  return portable as Site;
}

const PortableProviderSchema = ProviderOverrideSchema.omit({ env: true }).strict();

const profiles = defineSection({
  id: "profiles",
  paths: ["daemon.agentProfiles", "daemon.terminalProfiles"],
  schema: z
    .object({
      agentProfiles: z.array(AgentProfileSchema).optional(),
      terminalProfiles: z.array(TerminalProfileSchema).optional(),
    })
    .strict(),
  read(persisted, redacted) {
    const { agentProfiles, terminalProfiles } = persisted.daemon ?? {};
    terminalProfiles?.forEach((profile, index) => {
      if (isAbsoluteOnAnyPlatform(profile.command)) {
        redacted.push({ path: `daemon.terminalProfiles.${index}.command`, kind: "machine-path" });
      }
    });
    return definedEntries({ agentProfiles, terminalProfiles });
  },
  toApply: (value) => ({ kind: "patch", patch: value }),
});

const providers = defineSection({
  id: "providers",
  paths: ["agents.providers"],
  schema: z.record(z.string(), PortableProviderSchema),
  read(persisted, redacted) {
    const configured = persisted.agents?.providers;
    if (!configured || Object.keys(configured).length === 0) return undefined;
    const portable: Record<string, z.input<typeof PortableProviderSchema>> = {};
    for (const [providerId, settings] of Object.entries(configured)) {
      const { env, ...rest } = ProviderOverrideSchema.parse(settings);
      if (env !== undefined) {
        redacted.push({ path: `agents.providers.${providerId}.env`, kind: "secret" });
      }
      const command = rest.command?.[0];
      if (command !== undefined && isAbsoluteOnAnyPlatform(command)) {
        redacted.push({ path: `agents.providers.${providerId}.command`, kind: "machine-path" });
      }
      portable[providerId] = rest;
    }
    return portable;
  },
  toApply: (value) => ({ kind: "patch", patch: { providers: value } }),
});

const metadataGeneration = defineSection({
  id: "metadataGeneration",
  paths: ["agents.metadataGeneration"],
  schema: AgentMetadataGenerationSchema,
  read: (persisted) => persisted.agents?.metadataGeneration,
  toApply: (value) => ({
    kind: "patch",
    patch: { metadataGeneration: { providers: value.providers ?? [] } },
  }),
});

const agentBehavior = defineSection({
  id: "agentBehavior",
  paths: [
    "daemon.autoArchiveAfterMerge",
    "daemon.enableTerminalAgentHooks",
    "daemon.appendSystemPrompt",
    "daemon.mcp.injectIntoAgents",
    "daemon.browserTools.enabled",
    "agents.idleRuntimeCleanup",
  ],
  schema: z
    .object({
      autoArchiveAfterMerge: z.boolean().optional(),
      enableTerminalAgentHooks: z.boolean().optional(),
      appendSystemPrompt: z.string().optional(),
      injectIntoAgents: z.boolean().optional(),
      browserToolsEnabled: z.boolean().optional(),
      idleRuntimeCleanup: z.boolean().optional(),
    })
    .strict(),
  read(persisted) {
    const daemon = persisted.daemon;
    return definedEntries({
      autoArchiveAfterMerge: daemon?.autoArchiveAfterMerge,
      enableTerminalAgentHooks: daemon?.enableTerminalAgentHooks,
      appendSystemPrompt: daemon?.appendSystemPrompt,
      injectIntoAgents: daemon?.mcp?.injectIntoAgents,
      browserToolsEnabled: daemon?.browserTools?.enabled,
      idleRuntimeCleanup: persisted.agents?.idleRuntimeCleanup,
    });
  },
  toApply(value) {
    const { injectIntoAgents, browserToolsEnabled, ...topLevel } = value;
    return {
      kind: "patch",
      patch: {
        ...topLevel,
        ...(injectIntoAgents !== undefined ? { mcp: { injectIntoAgents } } : {}),
        ...(browserToolsEnabled !== undefined
          ? { browserTools: { enabled: browserToolsEnabled } }
          : {}),
      },
    };
  },
});

const speech = defineSection({
  id: "speech",
  paths: ["features.dictation", "features.voiceMode"],
  schema: z
    .object({
      dictation: FeatureDictationSchema.optional(),
      voiceMode: FeatureVoiceModeSchema.optional(),
    })
    .strict(),
  read(persisted, redacted) {
    const { dictation, voiceMode } = persisted.features ?? {};
    return definedEntries({
      dictation: dictation && {
        ...dictation,
        stt: stripSpeechSite(dictation.stt, "features.dictation.stt", redacted),
      },
      voiceMode: voiceMode && {
        ...voiceMode,
        stt: stripSpeechSite(voiceMode.stt, "features.voiceMode.stt", redacted),
        tts: stripSpeechSite(voiceMode.tts, "features.voiceMode.tts", redacted),
      },
    });
  },
  // The persisted site shapes are a subset of the speech patch shapes; the speech owner keeps
  // the target's stored key when a site keeps its provider.
  toApply: (value) => ({ kind: "patch", patch: { features: value as SpeechSettingsPatch } }),
});

const skills = defineSection({
  id: "skills",
  paths: ["agents.skills"],
  schema: AgentSkillSelectionSchema,
  read: (persisted) => persisted.agents?.skills?.selection,
  toApply: (selection) => ({ kind: "skills", selection }),
});

export const CONFIG_SECTIONS: readonly ConfigSection[] = [
  profiles,
  providers,
  metadataGeneration,
  agentBehavior,
  speech,
  skills,
];

/** Secrets that live outside every portable section. They never leave and are always listed. */
export function readHostSecrets(persisted: PersistedConfig): RedactedPath[] {
  const secrets: RedactedPath[] = [];
  if (persisted.daemon?.auth) secrets.push({ path: "daemon.auth.password", kind: "secret" });
  for (const host of Object.keys(persisted.pluginRegistries ?? {})) {
    secrets.push({ path: `pluginRegistries.${host}.authorization`, kind: "secret" });
  }
  return secrets;
}

export function sectionForPath(redactedPath: string): ConfigSection | undefined {
  return CONFIG_SECTIONS.find((section) =>
    section.paths.some(
      (prefix) => redactedPath === prefix || redactedPath.startsWith(`${prefix}.`),
    ),
  );
}

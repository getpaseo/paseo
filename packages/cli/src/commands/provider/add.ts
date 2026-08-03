import type { Command } from "commander";
import type { ProviderOverride, ProviderProfileModel } from "@getpaseo/protocol/provider-config";
import type {
  CommandError,
  CommandOptions,
  OutputSchema,
  SingleResult,
} from "../../output/index.js";
import { connectToDaemon, getDaemonHost } from "../../utils/client.js";
import { PROVIDER_ID_PATTERN, VALID_EXTENDS_VALUES, isBuiltinProviderId } from "./shared.js";

export interface ProviderAddOptions extends CommandOptions {
  extends?: string;
  label?: string;
  description?: string;
  env?: string[];
  model?: string[];
  command?: string[];
}

export interface ProviderAddRow {
  provider: string;
  label: string;
  extends: string;
  models: string;
  env: string;
  command: string;
}

export const providerAddSchema: OutputSchema<ProviderAddRow> = {
  idField: "provider",
  columns: [
    { header: "PROVIDER", field: "provider", width: 16 },
    { header: "LABEL", field: "label", width: 20 },
    { header: "EXTENDS", field: "extends", width: 10 },
    { header: "MODELS", field: "models", width: 30 },
    { header: "ENV", field: "env", width: 24 },
    { header: "COMMAND", field: "command", width: 30 },
  ],
};

const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

function parseEnvEntries(entries: string[]): Record<string, string> {
  const env: Record<string, string> = {};
  for (const entry of entries) {
    const separator = entry.indexOf("=");
    if (separator <= 0) {
      throw new Error(`Invalid --env "${entry}": expected KEY=VALUE`);
    }
    const key = entry.slice(0, separator);
    if (!ENV_KEY_PATTERN.test(key)) {
      throw new Error(`Invalid --env key "${key}": must match ${ENV_KEY_PATTERN}`);
    }
    env[key] = entry.slice(separator + 1);
  }
  return env;
}

function parseModelEntries(entries: string[]): ProviderProfileModel[] {
  return entries.map((entry, index) => {
    const separator = entry.indexOf("=");
    const id = separator === -1 ? entry : entry.slice(0, separator);
    const label = separator === -1 ? entry : entry.slice(separator + 1);
    if (id.trim().length === 0) {
      throw new Error(`Invalid --model "${entry}": expected id or id=label`);
    }
    if (label.trim().length === 0) {
      throw new Error(`Invalid --model "${entry}": label must not be empty`);
    }
    return { id, label, ...(index === 0 ? { isDefault: true } : {}) };
  });
}

/**
 * Build the provider override for `provider add`. The daemon validates too; this
 * catches the common mistakes before a round trip so the message names the flag.
 */
export function buildProviderOverride(
  id: string,
  options: ProviderAddOptions,
): { id: string; override: ProviderOverride } {
  if (!PROVIDER_ID_PATTERN.test(id)) {
    throw new Error(
      `Invalid provider id "${id}": must start with a lowercase letter and contain only lowercase letters, digits, and hyphens`,
    );
  }
  if (isBuiltinProviderId(id)) {
    throw new Error(
      `"${id}" is a built-in provider. Pick a different id and use --extends ${id} to base a profile on it.`,
    );
  }

  const extendsProvider = options.extends;
  if (!extendsProvider) {
    throw new Error(`--extends is required (one of: ${VALID_EXTENDS_VALUES.join(", ")})`);
  }
  if (!VALID_EXTENDS_VALUES.includes(extendsProvider)) {
    throw new Error(
      `Invalid --extends "${extendsProvider}": expected one of ${VALID_EXTENDS_VALUES.join(", ")}`,
    );
  }

  const commandArgv = options.command ?? [];
  if (extendsProvider === "acp" && commandArgv.length === 0) {
    throw new Error("--command is required when extending acp");
  }

  const env = parseEnvEntries(options.env ?? []);
  const models = parseModelEntries(options.model ?? []);

  const override: ProviderOverride = {
    extends: extendsProvider,
    label: options.label ?? id,
    ...(options.description ? { description: options.description } : {}),
    ...(commandArgv.length > 0 ? { command: commandArgv } : {}),
    ...(Object.keys(env).length > 0 ? { env } : {}),
    ...(models.length > 0 ? { models } : {}),
  };

  return { id, override };
}

function toRow(id: string, override: ProviderOverride): ProviderAddRow {
  return {
    provider: id,
    label: override.label ?? id,
    extends: override.extends ?? "-",
    models: (override.models ?? []).map((model) => model.id).join(", ") || "-",
    env: Object.keys(override.env ?? {}).join(", ") || "-",
    command: (override.command ?? []).join(" ") || "-",
  };
}

export async function runAddCommand(
  id: string,
  options: ProviderAddOptions,
  _command: Command,
): Promise<SingleResult<ProviderAddRow>> {
  let built: { id: string; override: ProviderOverride };
  try {
    built = buildProviderOverride(id, options);
  } catch (error) {
    throw {
      code: "INVALID_PROVIDER_CONFIG",
      message: error instanceof Error ? error.message : String(error),
    } satisfies CommandError;
  }

  const host = getDaemonHost({ host: options.host });
  const client = await connectToDaemon({ host: options.host }).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    throw {
      code: "DAEMON_NOT_RUNNING",
      message: `Cannot connect to daemon at ${host}: ${message}`,
    } satisfies CommandError;
  });

  try {
    const { config } = await client.getDaemonConfig();
    if (built.id in (config.providers ?? {})) {
      throw new Error(
        `Provider "${built.id}" already exists. Remove it with "paseo provider rm ${built.id}" first.`,
      );
    }

    await client.patchDaemonConfig({ providers: { [built.id]: built.override } });
    return { type: "single", data: toRow(built.id, built.override), schema: providerAddSchema };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw { code: "PROVIDER_ADD_FAILED", message } satisfies CommandError;
  } finally {
    await client.close().catch(() => undefined);
  }
}

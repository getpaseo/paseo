import type { Command } from "commander";
import type { CommandOptions, SingleResult, OutputSchema } from "../../output/index.js";
import { createEntry } from "../library/api.js";
import {
  VALID_SCOPES,
  VALID_TARGETS,
  VALID_TRANSPORTS,
  type LibraryScope,
  type LibrarySyncTarget,
  type LibraryVisibility,
  type McpPayload,
  type McpTransport,
} from "../library/types.js";

export interface McpAddOptions extends CommandOptions {
  transport?: string;
  command?: string;
  arg?: string[];
  url?: string;
  header?: string[];
  env?: string[];
  description?: string;
  scope?: string;
  scopeId?: string;
  visibility?: string;
  target?: string[];
}

interface McpAddRow {
  id: string;
  name: string;
  transport: string;
  scope: string;
}

const schema: OutputSchema<McpAddRow> = {
  idField: "id",
  columns: [
    { header: "ID", field: "id", width: 36 },
    { header: "NAME", field: "name", width: 24 },
    { header: "TRANSPORT", field: "transport", width: 10 },
    { header: "SCOPE", field: "scope", width: 12 },
  ],
};

function parseKeyValue(items: string[] | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const item of items ?? []) {
    const idx = item.indexOf("=");
    if (idx <= 0) {
      throw {
        code: "INVALID_INPUT",
        message: `Expected KEY=VALUE, got "${item}"`,
      };
    }
    out[item.slice(0, idx)] = item.slice(idx + 1);
  }
  return out;
}

function ensureEnum<T extends string>(
  value: string | undefined,
  allowed: readonly T[],
  label: string,
  fallback: T,
): T {
  if (value === undefined) return fallback;
  if (!(allowed as readonly string[]).includes(value)) {
    throw {
      code: "INVALID_INPUT",
      message: `Invalid ${label} "${value}"`,
      details: `Allowed: ${allowed.join(", ")}`,
    };
  }
  return value as T;
}

export async function runMcpAddCommand(
  name: string,
  options: McpAddOptions,
  _command: Command,
): Promise<SingleResult<McpAddRow>> {
  const transport = ensureEnum<McpTransport>(
    options.transport,
    VALID_TRANSPORTS,
    "transport",
    "stdio",
  );
  const scope = ensureEnum<LibraryScope>(options.scope, VALID_SCOPES, "scope", "user");
  const visibility = ensureEnum<LibraryVisibility>(
    options.visibility,
    ["private", "shared"],
    "visibility",
    scope === "user" ? "private" : "private",
  );

  const targets: LibrarySyncTarget[] = (options.target ?? VALID_TARGETS).map((t) =>
    ensureEnum<LibrarySyncTarget>(t, VALID_TARGETS, "target", "claude-code"),
  );

  const env = parseKeyValue(options.env);

  let payload: McpPayload;
  if (transport === "stdio") {
    if (!options.command) {
      throw { code: "INVALID_INPUT", message: "--command is required for stdio transport" };
    }
    payload = {
      transport: "stdio",
      command: options.command,
      ...(options.arg?.length ? { args: options.arg } : {}),
      ...(Object.keys(env).length ? { env } : {}),
    };
  } else {
    if (!options.url) {
      throw {
        code: "INVALID_INPUT",
        message: `--url is required for ${transport} transport`,
      };
    }
    const headers = parseKeyValue(options.header);
    payload = {
      transport,
      url: options.url,
      ...(Object.keys(headers).length ? { headers } : {}),
      ...(Object.keys(env).length ? { env } : {}),
    };
  }

  const entry = await createEntry({
    kind: "mcp",
    name,
    payload,
    description: options.description ?? null,
    scope,
    scopeId: options.scopeId ?? null,
    visibility,
    syncTargets: targets,
  });

  return {
    type: "single",
    data: {
      id: entry.id,
      name: entry.displayName || entry.name,
      transport,
      scope:
        entry.scope === "user" ? "user" : `${entry.scope}:${entry.scopeId?.slice(0, 8) ?? "?"}`,
    },
    schema,
  };
}

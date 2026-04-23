import { readFile } from "node:fs/promises";
import type { Command } from "commander";
import type { CommandOptions, SingleResult, OutputSchema } from "../../output/index.js";
import { createEntry } from "../library/api.js";
import {
  VALID_SCOPES,
  VALID_TARGETS,
  type LibraryScope,
  type LibrarySyncTarget,
  type LibraryVisibility,
  type SkillPayload,
} from "../library/types.js";

export interface SkillsAddOptions extends CommandOptions {
  file?: string;
  body?: string;
  url?: string;
  description?: string;
  example?: string;
  scope?: string;
  scopeId?: string;
  visibility?: string;
  target?: string[];
  displayName?: string;
}

interface SkillAddRow {
  id: string;
  name: string;
  scope: string;
}

const schema: OutputSchema<SkillAddRow> = {
  idField: "id",
  columns: [
    { header: "ID", field: "id", width: 36 },
    { header: "NAME", field: "name", width: 28 },
    { header: "SCOPE", field: "scope", width: 12 },
  ],
};

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

export async function runSkillsAddCommand(
  name: string,
  options: SkillsAddOptions,
  _command: Command,
): Promise<SingleResult<SkillAddRow>> {
  const scope = ensureEnum<LibraryScope>(options.scope, VALID_SCOPES, "scope", "user");
  const visibility = ensureEnum<LibraryVisibility>(
    options.visibility,
    ["private", "shared"],
    "visibility",
    "private",
  );
  const targets: LibrarySyncTarget[] = (options.target ?? VALID_TARGETS).map((t) =>
    ensureEnum<LibrarySyncTarget>(t, VALID_TARGETS, "target", "claude-code"),
  );

  let instructionsInline: string | undefined;
  if (options.file) {
    instructionsInline = await readFile(options.file, "utf-8");
  } else if (options.body) {
    instructionsInline = options.body;
  }

  if (!instructionsInline && !options.url) {
    throw {
      code: "INVALID_INPUT",
      message: "Provide skill content via --file, --body, or --url",
    };
  }

  const payload: SkillPayload = {
    ...(instructionsInline ? { instructionsInline } : {}),
    ...(options.url ? { instructionsUrl: options.url } : {}),
    ...(options.example ? { examplePrompt: options.example } : {}),
  };

  const entry = await createEntry({
    kind: "skill",
    name,
    displayName: options.displayName,
    description: options.description ?? null,
    payload,
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
      scope:
        entry.scope === "user" ? "user" : `${entry.scope}:${entry.scopeId?.slice(0, 8) ?? "?"}`,
    },
    schema,
  };
}

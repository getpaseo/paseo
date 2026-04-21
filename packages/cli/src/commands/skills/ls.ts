import type { Command } from "commander";
import type { CommandOptions, ListResult, OutputSchema } from "../../output/index.js";
import { listEntries } from "../library/api.js";

interface SkillRow {
  id: string;
  name: string;
  scope: string;
  visibility: string;
  source: string;
  active: string;
}

const schema: OutputSchema<SkillRow> = {
  idField: "id",
  columns: [
    { header: "ID", field: "id", width: 12 },
    { header: "NAME", field: "name", width: 28 },
    { header: "SCOPE", field: "scope", width: 12 },
    { header: "VISIBILITY", field: "visibility", width: 10 },
    { header: "SOURCE", field: "source", width: 8 },
    {
      header: "ACTIVE",
      field: "active",
      width: 7,
      color: (v) => (v === "yes" ? "green" : "gray"),
    },
  ],
};

export interface SkillsLsOptions extends CommandOptions {
  scope?: string;
  scopeId?: string;
}

export async function runSkillsLsCommand(
  options: SkillsLsOptions,
  _command: Command,
): Promise<ListResult<SkillRow>> {
  const entries = await listEntries({
    kind: "skill",
    scope: options.scope as never,
    scopeId: options.scopeId,
  });

  const rows: SkillRow[] = entries.map((e) => ({
    id: e.id.slice(0, 12),
    name: e.displayName || e.name,
    scope:
      e.scope === "user"
        ? "user"
        : `${e.scope}:${e.scopeId ? e.scopeId.slice(0, 8) : "?"}`,
    visibility: e.visibility,
    source: e.source,
    active: e.activation?.active ? "yes" : "no",
  }));

  return { type: "list", data: rows, schema };
}

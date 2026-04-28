import type { Command } from "commander";
import type { CommandOptions, ListResult, OutputSchema } from "../../output/index.js";
import { listEntries } from "../library/api.js";
import type { McpPayload } from "../library/types.js";

interface McpRow {
  id: string;
  name: string;
  transport: string;
  scope: string;
  visibility: string;
  source: string;
  active: string;
}

const schema: OutputSchema<McpRow> = {
  idField: "id",
  columns: [
    { header: "ID", field: "id", width: 12 },
    { header: "NAME", field: "name", width: 24 },
    { header: "TRANSPORT", field: "transport", width: 10 },
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

export interface McpLsOptions extends CommandOptions {
  scope?: string;
  scopeId?: string;
}

export async function runMcpLsCommand(
  options: McpLsOptions,
  _command: Command,
): Promise<ListResult<McpRow>> {
  const entries = await listEntries({
    kind: "mcp",
    scope: options.scope as McpRow["scope"] | undefined as never,
    scopeId: options.scopeId,
  });

  const rows: McpRow[] = entries.map((e) => {
    const transport = (e.payload as McpPayload).transport;
    const scopeLabel =
      e.scope === "user" ? "user" : `${e.scope}:${e.scopeId ? e.scopeId.slice(0, 8) : "?"}`;
    return {
      id: e.id.slice(0, 12),
      name: e.displayName || e.name,
      transport,
      scope: scopeLabel,
      visibility: e.visibility,
      source: e.source,
      active: e.activation?.active ? "yes" : "no",
    };
  });

  return { type: "list", data: rows, schema };
}

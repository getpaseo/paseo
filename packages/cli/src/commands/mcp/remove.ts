import type { Command } from "commander";
import type { CommandOptions, SingleResult, OutputSchema } from "../../output/index.js";
import { deleteEntry, listEntries } from "../library/api.js";

interface McpRemoveRow {
  id: string;
  status: string;
}

const schema: OutputSchema<McpRemoveRow> = {
  idField: "id",
  columns: [
    { header: "ID", field: "id", width: 36 },
    {
      header: "STATUS",
      field: "status",
      width: 10,
      color: (v) => (v === "removed" ? "green" : undefined),
    },
  ],
};

export async function runMcpRemoveCommand(
  identifier: string,
  _options: CommandOptions,
  _command: Command,
): Promise<SingleResult<McpRemoveRow>> {
  const entries = await listEntries({ kind: "mcp" });
  const match =
    entries.find((e) => e.id === identifier) ??
    entries.find((e) => e.id.startsWith(identifier)) ??
    entries.find((e) => e.name === identifier);

  if (!match) {
    throw {
      code: "NOT_FOUND",
      message: `No MCP entry matches "${identifier}"`,
      details: "Use `hubcode mcp ls` to see available IDs and names.",
    };
  }

  await deleteEntry(match.id);
  return {
    type: "single",
    data: { id: match.id, status: "removed" },
    schema,
  };
}

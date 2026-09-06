import type { PaseoTerminal } from "@getpaseo/client";
import type { OutputSchema } from "../../output/index.js";

export type TerminalRow = PaseoTerminal;

export interface TerminalKillRow {
  terminalId: string;
  success: boolean;
}

export const terminalSchema: OutputSchema<TerminalRow> = {
  idField: "id",
  columns: [
    { header: "ID", field: (row) => row.id.slice(0, 8), width: 8 },
    { header: "NAME", field: "name", width: 24 },
    { header: "CWD", field: "cwd", width: 48 },
    { header: "WORKSPACE", field: "workspaceId", width: 24 },
  ],
};

export const terminalKillSchema: OutputSchema<TerminalKillRow> = {
  idField: "terminalId",
  columns: [
    { header: "ID", field: (row) => row.terminalId.slice(0, 8), width: 8 },
    { header: "SUCCESS", field: "success", width: 8 },
  ],
};

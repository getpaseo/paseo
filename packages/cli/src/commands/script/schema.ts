import type { WorkspaceScriptPayload } from "@getpaseo/protocol/messages";
import type { OutputSchema } from "../../output/index.js";

export type WorkspaceScriptRow = WorkspaceScriptPayload;

export const workspaceScriptSchema: OutputSchema<WorkspaceScriptRow> = {
  idField: "scriptName",
  columns: [
    { header: "NAME", field: "scriptName", width: 20 },
    { header: "TYPE", field: "type", width: 9 },
    { header: "LIFECYCLE", field: "lifecycle", width: 10 },
    { header: "HEALTH", field: (script) => script.health ?? "-", width: 10 },
    { header: "PORT", field: (script) => script.port ?? "-", width: 7 },
    { header: "PROXY URL", field: (script) => script.proxyUrl ?? "-", width: 42 },
    { header: "TERMINAL", field: (script) => script.terminalId ?? "-", width: 12 },
  ],
};

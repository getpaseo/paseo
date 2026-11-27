import type { WorkspaceLaunchPayload } from "@getpaseo/protocol/messages";
import type { OutputSchema } from "../../output/index.js";

export type WorkspaceLaunchRow = WorkspaceLaunchPayload;

export const workspaceLaunchSchema: OutputSchema<WorkspaceLaunchRow> = {
  idField: "launchName",
  columns: [
    { header: "NAME", field: "launchName", width: 20 },
    { header: "ACTIVE", field: (launch) => (launch.active ? "yes" : "-"), width: 8 },
    { header: "LIFECYCLE", field: "lifecycle", width: 10 },
    {
      header: "PORT BLOCK",
      field: (launch) =>
        launch.portBase === null || launch.portEnd === null
          ? "-"
          : `${launch.portBase}-${launch.portEnd}`,
      width: 16,
    },
    { header: "ENDPOINTS", field: (launch) => launch.endpoints.length, width: 10 },
    { header: "TERMINAL", field: (launch) => launch.terminalId ?? "-", width: 12 },
  ],
};

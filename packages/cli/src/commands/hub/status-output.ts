import type { ListResult, OutputSchema } from "../../output/index.js";
import type { HubStatus } from "./daemon-client.js";

export interface HubRow {
  state: string;
  daemonId: string | null;
  hub: string | null;
  permissions: string;
  connectedAt: string | null;
  error: string | null;
  warning?: string;
}

const schema: OutputSchema<HubRow> = {
  idField: "state",
  columns: [
    { header: "STATE", field: "state" },
    { header: "HUB", field: "hub" },
    { header: "DAEMON", field: "daemonId" },
    { header: "PERMISSIONS", field: "permissions" },
    { header: "CONNECTED", field: "connectedAt" },
    { header: "ERROR", field: "error" },
    { header: "WARNING", field: "warning" },
  ],
};

export function hubStatusResult(
  status: HubStatus,
  warning?: string,
  reportedHubOrigin: string | null = status.hubOrigin,
): ListResult<HubRow> {
  return {
    type: "list",
    data: [
      {
        state: status.state,
        daemonId: status.daemonId,
        hub: reportedHubOrigin,
        permissions: status.permissions.join(", "),
        connectedAt: status.connectedAt,
        error: status.lastError,
        warning,
      },
    ],
    schema,
  };
}

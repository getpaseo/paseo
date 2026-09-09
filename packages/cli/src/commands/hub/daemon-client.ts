import { connectToDaemon } from "../../utils/client.js";
import type { ProviderSnapshotEntry } from "@getpaseo/protocol/agent-types";

export interface HubStatus {
  state: string;
  daemonId: string | null;
  hubOrigin: string | null;
  permissions: string[];
  connectedAt: string | null;
  lastError: string | null;
}

export interface HubProvidersSnapshotOptions {
  cwd?: string;
}

export interface HubDaemonClient {
  connectHub(
    url: string,
    token: string,
    permissions?: readonly string[],
  ): Promise<{ status: HubStatus }>;
  updateHubPermissions(input: {
    grant?: readonly string[];
    revoke?: readonly string[];
  }): Promise<{ status: HubStatus }>;
  getHubStatus(): Promise<{ status: HubStatus }>;
  disconnectHub(force: boolean): Promise<{ status: HubStatus; warning?: string }>;
  getProvidersSnapshot(
    options?: HubProvidersSnapshotOptions,
  ): Promise<{ entries: ProviderSnapshotEntry[] }>;
  close(): Promise<void>;
}

export interface HubDaemonConnection {
  connect(host: string | undefined): Promise<HubDaemonClient>;
}

export const productionHubDaemonConnection: HubDaemonConnection = {
  connect: (host) => connectToDaemon({ host }),
};

export async function withHubDaemon<T>(
  connection: HubDaemonConnection,
  host: string | undefined,
  action: (client: HubDaemonClient) => Promise<T>,
): Promise<T> {
  const client = await connection.connect(host);
  try {
    return await action(client);
  } finally {
    await client.close().catch(() => undefined);
  }
}

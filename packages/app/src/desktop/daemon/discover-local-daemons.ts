import { invokeDesktopCommand } from "@/desktop/electron/invoke";
import {
  buildClientConfig,
  connectAndProbe,
  getConnectionAuthFailureReason,
} from "@/utils/test-daemon-connection";

export interface DiscoveredLocalDaemon {
  host: string;
  port: number;
  hostname: string | null;
  serverId: string | null;
  passwordRequired: boolean;
}

export async function discoverLocalDaemons(): Promise<DiscoveredLocalDaemon[]> {
  return probeLocalDaemons(false);
}

export async function discoverStartupLocalDaemons(): Promise<DiscoveredLocalDaemon[]> {
  return probeLocalDaemons(true);
}

async function probeLocalDaemons(forStartup: boolean): Promise<DiscoveredLocalDaemon[]> {
  const candidates = await invokeDesktopCommand<{ host: string; port: number }[]>(
    "desktop_local_daemon_candidates",
    { forStartup },
  );
  const results = await Promise.all(
    candidates.map(async (candidate): Promise<DiscoveredLocalDaemon | null> => {
      try {
        // A real Paseo handshake distinguishes a daemon from an unrelated HTTP
        // service. Probing does not save a host or transfer lifecycle ownership.
        const config = await buildClientConfig({
          id: `discovery:${candidate.host}:${candidate.port}`,
          type: "directTcp",
          endpoint: `${candidate.host}:${candidate.port}`,
          useTls: false,
        });
        const { client, hostname, serverId } = await connectAndProbe(
          {
            ...config,
            // Do not displace this app's live connection to an already saved host.
            clientId: `${config.clientId}:discovery:${candidate.host}:${candidate.port}`,
          },
          1500,
        );
        await client.close();
        return {
          host: candidate.host,
          port: candidate.port,
          hostname,
          serverId,
          passwordRequired: false,
        };
      } catch (error) {
        if (getConnectionAuthFailureReason(error) === "password_required") {
          return {
            host: candidate.host,
            port: candidate.port,
            hostname: null,
            serverId: null,
            passwordRequired: true,
          };
        }
        return null;
      }
    }),
  );
  return results.filter((result): result is DiscoveredLocalDaemon => result !== null);
}

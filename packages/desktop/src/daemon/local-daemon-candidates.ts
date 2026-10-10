import { loadPersistedConfig } from "@getpaseo/server/configuration";
import { readDaemonInstance } from "@getpaseo/server/daemon-control";

export interface LocalDaemonCandidate {
  host: string;
  port: number;
}

// Discovery is bounded to loopback and known listen ports. It never starts a
// daemon, scans the network, or changes ownership of an existing process.
export function localDaemonCandidates(
  listens: (string | null | undefined)[],
  includeDefaultPorts = true,
): LocalDaemonCandidate[] {
  const candidates = new Map<string, LocalDaemonCandidate>();
  const addresses = includeDefaultPorts ? [...listens, "127.0.0.1:6767", "[::1]:6767"] : listens;
  for (const listen of addresses) {
    if (!listen) continue;
    const match = listen
      .trim()
      .match(/^(?:(127\.0\.0\.1|localhost|0\.0\.0\.0|\[::\]|\[::1\]):)?(\d+)$/);
    if (match) {
      const hostname = match[1] ?? "127.0.0.1";
      let host = hostname;
      if (["localhost", "0.0.0.0"].includes(hostname)) host = "127.0.0.1";
      else if (hostname === "[::]") host = "[::1]";
      const port = Number(match[2]);
      if (
        !["127.0.0.1", "[::1]"].includes(host) ||
        !Number.isInteger(port) ||
        port < 1 ||
        port > 65535
      )
        continue;
      candidates.set(`${host}:${port}`, { host, port });
    }
  }
  return [...candidates.values()];
}

export async function getLocalDaemonCandidates(
  home: string,
  forStartup = false,
): Promise<LocalDaemonCandidate[]> {
  const instance = await readDaemonInstance(home).catch(() => null);
  // The manager already knows how to reuse this instance, including its local
  // credentials and socket/pipe transport. Preserve that path unchanged.
  if (forStartup && instance) return [];
  let listen: string | undefined;
  try {
    listen = loadPersistedConfig(home).daemon?.listen;
  } catch {
    // A broken config must not prevent connecting to a separate local daemon.
  }
  if (forStartup) {
    // Preserve the original manager's socket/pipe reuse and explicit custom
    // listen configuration. Broad discovery belongs to the connection picker.
    const target = instance?.listen ?? listen ?? "127.0.0.1:6767";
    return localDaemonCandidates([target], false);
  }
  return localDaemonCandidates([instance?.listen, listen]);
}

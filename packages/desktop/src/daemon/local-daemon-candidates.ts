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
): LocalDaemonCandidate[] {
  const candidates = new Map<string, LocalDaemonCandidate>();
  for (const listen of [...listens, "127.0.0.1:6767", "[::1]:6767"]) {
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

export async function getLocalDaemonCandidates(home: string): Promise<LocalDaemonCandidate[]> {
  const instance = await readDaemonInstance(home).catch(() => null);
  let listen: string | undefined;
  try {
    listen = loadPersistedConfig(home).daemon?.listen;
  } catch {
    // A broken config must not prevent connecting to a separate local daemon.
  }
  return localDaemonCandidates([instance?.listen, listen]);
}

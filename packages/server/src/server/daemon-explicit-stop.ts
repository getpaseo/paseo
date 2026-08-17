import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

const DAEMON_EXPLICIT_STOP_FILENAME = "daemon-explicit-stop";

function resolveDaemonExplicitStopPath(paseoHome: string): string {
  return path.join(paseoHome, DAEMON_EXPLICIT_STOP_FILENAME);
}

export function writeDaemonExplicitStopIntent(paseoHome: string, ownerPid: number): void {
  mkdirSync(paseoHome, { recursive: true });
  writeFileSync(resolveDaemonExplicitStopPath(paseoHome), `${ownerPid}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

export function clearDaemonExplicitStopIntent(paseoHome: string): void {
  rmSync(resolveDaemonExplicitStopPath(paseoHome), { force: true });
}

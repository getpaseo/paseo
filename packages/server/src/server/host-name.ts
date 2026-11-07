import { execFileSync } from "node:child_process";
import { hostname } from "node:os";

let hostName: string | undefined;

// macOS's kernel hostname comes from DHCP/reverse DNS and can be "UNKNOWN";
// ComputerName is the name the user gave the Mac.
export function getHostName(): string {
  hostName ??=
    process.platform === "darwin"
      ? execFileSync("/usr/sbin/scutil", ["--get", "ComputerName"], { encoding: "utf8" }).trim()
      : hostname();
  return hostName;
}

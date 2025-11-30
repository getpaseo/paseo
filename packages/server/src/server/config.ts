import os from "node:os";
import path from "node:path";
import { mkdirSync } from "node:fs";

let cachedHomeDir: string | null = null;
let cachedPort: number | null = null;

function expandHomeDir(input: string): string {
  if (input.startsWith("~/")) {
    return path.join(os.homedir(), input.slice(2));
  }
  if (input === "~") {
    return os.homedir();
  }
  return input;
}

export function resolvePaseoHome(): string {
  if (cachedHomeDir) {
    return cachedHomeDir;
  }
  const raw = process.env.PASEO_HOME ?? process.env.PASEO_HOME_DIR ?? "~/.paseo";
  const expanded = path.resolve(expandHomeDir(raw));
  mkdirSync(expanded, { recursive: true });
  cachedHomeDir = expanded;
  return cachedHomeDir;
}

export function resolvePaseoPort(): number {
  if (cachedPort !== null) {
    return cachedPort;
  }
  const raw = process.env.PASEO_PORT ?? process.env.PORT ?? "6767";
  const parsed = Number.parseInt(raw, 10);
  cachedPort = Number.isFinite(parsed) ? parsed : 6767;
  return cachedPort;
}

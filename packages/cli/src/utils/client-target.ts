import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

const CLI_CONFIG_FILENAME = "cli.json";

interface PersistedCliConfig {
  version: 1;
  defaultDaemonTarget: string;
}

function resolveCliConfigPath(paseoHome: string): string {
  return path.join(paseoHome, CLI_CONFIG_FILENAME);
}

function parsePersistedCliConfig(raw: unknown, configPath: string): PersistedCliConfig {
  if (
    !raw ||
    typeof raw !== "object" ||
    (raw as { version?: unknown }).version !== 1 ||
    typeof (raw as { defaultDaemonTarget?: unknown }).defaultDaemonTarget !== "string" ||
    !(raw as { defaultDaemonTarget: string }).defaultDaemonTarget.trim()
  ) {
    throw new Error(`Invalid Paseo CLI config at ${configPath}`);
  }

  return {
    version: 1,
    defaultDaemonTarget: (raw as { defaultDaemonTarget: string }).defaultDaemonTarget.trim(),
  };
}

export function readDefaultDaemonTarget(paseoHome: string): string | null {
  const configPath = resolveCliConfigPath(paseoHome);
  if (!existsSync(configPath)) {
    return null;
  }

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(configPath, "utf8")) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Cannot read Paseo CLI config at ${configPath}: ${message}`, { cause: error });
  }

  return parsePersistedCliConfig(raw, configPath).defaultDaemonTarget;
}

export function saveDefaultDaemonTarget(paseoHome: string, target: string): void {
  const normalizedTarget = target.trim();
  if (!normalizedTarget) {
    throw new Error("Daemon target cannot be empty");
  }

  mkdirSync(paseoHome, { recursive: true, mode: 0o700 });
  const configPath = resolveCliConfigPath(paseoHome);
  const temporaryPath = path.join(
    paseoHome,
    `.${CLI_CONFIG_FILENAME}.${process.pid}.${randomUUID()}.tmp`,
  );
  const config: PersistedCliConfig = {
    version: 1,
    defaultDaemonTarget: normalizedTarget,
  };

  try {
    writeFileSync(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    renameSync(temporaryPath, configPath);
    chmodSync(configPath, 0o600);
  } finally {
    rmSync(temporaryPath, { force: true });
  }
}

export function clearDefaultDaemonTarget(paseoHome: string): boolean {
  const configPath = resolveCliConfigPath(paseoHome);
  if (!existsSync(configPath)) {
    return false;
  }
  rmSync(configPath);
  return true;
}

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export const PASEO_LAUNCH_AGENT_LABEL = "sh.paseo.desktop.daemon";

export interface PaseoLaunchAgentInput {
  home?: string;
  resourcesPath: string;
  platform?: NodeJS.Platform;
}

export interface PaseoLaunchAgentResult {
  path: string;
  changed: boolean;
}

export class PaseoLaunchAgentOwnershipError extends Error {
  constructor(public readonly filePath: string) {
    super(`refusing to overwrite unmanaged LaunchAgent at ${filePath}`);
    this.name = "PaseoLaunchAgentOwnershipError";
  }
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function requireAbsolutePath(value: string, label: string): string {
  if (!path.isAbsolute(value) || value.includes("\n") || value.includes("\r")) {
    throw new Error(`${label} must be an absolute single-line path`);
  }
  return value;
}

function launchAgentDirectory(home: string): string {
  return path.join(home, "Library", "LaunchAgents");
}

export function resolvePaseoLaunchAgentPath(home = os.homedir()): string {
  return path.join(launchAgentDirectory(home), `${PASEO_LAUNCH_AGENT_LABEL}.plist`);
}

export function createPaseoLaunchAgentPlist(input: {
  home: string;
  resourcesPath: string;
}): string {
  const home = requireAbsolutePath(input.home, "home");
  const resourcesPath = requireAbsolutePath(input.resourcesPath, "resourcesPath");
  const daemonLauncher = path.join(resourcesPath, "bin", "paseo-daemon-launcher");
  const cliPath = path.join(resourcesPath, "bin", "paseo");
  const logDirectory = path.join(home, ".paseo");

  const text = (value: string): string => `<string>${escapeXml(value)}</string>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  ${text(PASEO_LAUNCH_AGENT_LABEL)}
  <key>ProgramArguments</key>
  <array>
    ${text(daemonLauncher)}
  </array>
  <key>WorkingDirectory</key>
  ${text(home)}
  <key>EnvironmentVariables</key>
  <dict>
    <key>PASEO_DESKTOP_MANAGED</key>
    <string>1</string>
    <key>PASEO_CLI</key>
    ${text(cliPath)}
    <key>PASEO_WEB_UI_ENABLED</key>
    <string>false</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>StandardOutPath</key>
  ${text(path.join(logDirectory, "launchd.stdout.log"))}
  <key>StandardErrorPath</key>
  ${text(path.join(logDirectory, "launchd.stderr.log"))}
</dict>
</plist>
`;
}

function readExistingManagedLaunchAgent(filePath: string): string | null {
  if (!existsSync(filePath)) return null;
  const existing = readFileSync(filePath, "utf8");
  if (
    !existing.includes(`<string>${PASEO_LAUNCH_AGENT_LABEL}</string>`) ||
    !existing.includes("<key>PASEO_DESKTOP_MANAGED</key>")
  ) {
    throw new PaseoLaunchAgentOwnershipError(filePath);
  }
  return existing;
}

export function reconcilePaseoLaunchAgent(
  input: PaseoLaunchAgentInput,
): PaseoLaunchAgentResult | null {
  if ((input.platform ?? process.platform) !== "darwin") return null;

  const home = input.home ?? os.homedir();
  const filePath = resolvePaseoLaunchAgentPath(home);
  const contents = createPaseoLaunchAgentPlist({ home, resourcesPath: input.resourcesPath });
  const existing = readExistingManagedLaunchAgent(filePath);
  if (existing === contents) {
    return { path: filePath, changed: false };
  }

  mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tempPath = `${filePath}.${process.pid}.tmp`;
  writeFileSync(tempPath, contents, { encoding: "utf8", mode: 0o600 });
  renameSync(tempPath, filePath);
  return { path: filePath, changed: true };
}

import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { app } from "electron";
import log from "electron-log/main";
import { resolveCliInstallSourcePath } from "./cli-install-path.js";
import { syncSkills } from "./skill-sync.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface InstallStatus {
  installed: boolean;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SKILL_NAMES = [
  "paseo",
  "paseo-advisor",
  "paseo-committee",
  "paseo-epic",
  "paseo-handoff",
  "paseo-loop",
  "paseo-orchestrate",
];

// ---------------------------------------------------------------------------
// Filesystem helpers
// ---------------------------------------------------------------------------

async function pathOrSymlinkExists(p: string): Promise<boolean> {
  try {
    await fs.lstat(p);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

function getLocalBinDir(): string {
  return path.join(os.homedir(), ".local", "bin");
}

function getCliTargetPath(): string {
  const filename = process.platform === "win32" ? "paseo.cmd" : "paseo";
  return path.join(getLocalBinDir(), filename);
}

function getBundledCliShimPath(): string {
  const cliShimFilename = process.platform === "win32" ? "paseo.cmd" : "paseo";

  if (process.platform === "darwin") {
    const electronExePath = app.getPath("exe");
    const appBundle = electronExePath.replace(/\/Contents\/MacOS\/.+$/, "");
    return path.join(appBundle, "Contents", "Resources", "bin", cliShimFilename);
  }

  if (process.platform === "win32") {
    const electronExePath = app.getPath("exe");
    return path.join(path.dirname(electronExePath), "resources", "bin", cliShimFilename);
  }

  // Linux
  const electronExePath = app.getPath("exe");
  return path.join(path.dirname(electronExePath), "resources", "bin", cliShimFilename);
}

function getBundledSkillsDir(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "skills");
  }
  return path.join(__dirname, "..", "..", "..", "..", "skills");
}

function getAgentsSkillsDir(): string {
  return path.join(os.homedir(), ".agents", "skills");
}

function getClaudeSkillsDir(): string {
  return path.join(os.homedir(), ".claude", "skills");
}

function getCodexSkillsDir(): string {
  return path.join(os.homedir(), ".codex", "skills");
}

// ---------------------------------------------------------------------------
// Shell PATH helpers
// ---------------------------------------------------------------------------

interface ShellRcInfo {
  shell: string;
  rcFile: string;
  pathCheckPattern: RegExp;
  exportLine: string;
}

function detectShellRcInfo(): ShellRcInfo | null {
  if (process.platform === "win32") return null;

  const shell = process.env.SHELL;
  if (!shell) return null;

  const shellName = path.basename(shell);

  if (shellName === "zsh") {
    return {
      shell: "zsh",
      rcFile: path.join(os.homedir(), ".zshrc"),
      pathCheckPattern: /\.local\/bin/,
      exportLine: 'export PATH="$HOME/.local/bin:$PATH"',
    };
  }

  if (shellName === "bash") {
    const rcFile =
      process.platform === "darwin"
        ? path.join(os.homedir(), ".bash_profile")
        : path.join(os.homedir(), ".bashrc");
    return {
      shell: "bash",
      rcFile,
      pathCheckPattern: /\.local\/bin/,
      exportLine: 'export PATH="$HOME/.local/bin:$PATH"',
    };
  }

  if (shellName === "fish") {
    return {
      shell: "fish",
      rcFile: path.join(os.homedir(), ".config", "fish", "config.fish"),
      pathCheckPattern: /\.local\/bin/,
      exportLine: "fish_add_path $HOME/.local/bin",
    };
  }

  return null;
}

function pathAlreadyContainsLocalBin(): boolean {
  const pathEnv = process.env.PATH ?? "";
  const localBin = path.join(os.homedir(), ".local", "bin");
  return pathEnv.split(path.delimiter).some((p) => p === localBin || p === "~/.local/bin");
}

async function ensurePathInShellRc(): Promise<{ shellUpdated: boolean }> {
  if (pathAlreadyContainsLocalBin()) {
    return { shellUpdated: false };
  }

  const info = detectShellRcInfo();
  if (!info) {
    return { shellUpdated: false };
  }

  try {
    const exists = await pathOrSymlinkExists(info.rcFile);
    if (exists) {
      const content = await fs.readFile(info.rcFile, "utf-8");
      if (info.pathCheckPattern.test(content)) {
        return { shellUpdated: false };
      }
    }

    await fs.mkdir(path.dirname(info.rcFile), { recursive: true });
    await fs.appendFile(info.rcFile, `\n# Added by Paseo\n${info.exportLine}\n`);

    return { shellUpdated: true };
  } catch (err) {
    log.warn("[integrations] Failed to update shell rc file", { rcFile: info.rcFile, err });
    return { shellUpdated: false };
  }
}

// ---------------------------------------------------------------------------
// CLI Installation
// ---------------------------------------------------------------------------

export async function installCli(): Promise<InstallStatus> {
  const targetPath = getCliTargetPath();
  const shimPath = getBundledCliShimPath();
  const installSourcePath = resolveCliInstallSourcePath({
    platform: process.platform,
    isPackaged: app.isPackaged,
    executablePath: app.getPath("exe"),
    shimPath,
    appImagePath: process.env.APPIMAGE,
  });
  const binDir = getLocalBinDir();

  await fs.mkdir(binDir, { recursive: true });

  if (process.platform === "win32") {
    if (await pathOrSymlinkExists(targetPath)) {
      await fs.unlink(targetPath);
    }
    // Generate a thin .cmd trampoline that delegates to the bundled shim.
    // Only the app install path is baked in — internal details (asar layout,
    // entrypoint scripts) live in the bundled shim and update with the app.
    const cmdContent = [
      "@echo off",
      `set "BUNDLED_CLI=${shimPath}"`,
      `if not exist "%BUNDLED_CLI%" (`,
      `  echo Paseo CLI not found at %BUNDLED_CLI% — is Paseo installed? 1>&2`,
      `  exit /b 1`,
      `)`,
      `call "%BUNDLED_CLI%" %*`,
      `exit /b %errorlevel%`,
    ].join("\r\n");
    await fs.writeFile(targetPath, cmdContent, "utf-8");
  } else {
    if (await pathOrSymlinkExists(targetPath)) {
      await fs.unlink(targetPath);
    }
    await fs.symlink(installSourcePath, targetPath);
  }

  const { shellUpdated } = await ensurePathInShellRc();
  if (shellUpdated) {
    log.info("[integrations] Updated shell rc with ~/.local/bin PATH");
  }

  return getCliInstallStatus();
}

export async function getCliInstallStatus(): Promise<InstallStatus> {
  const targetPath = getCliTargetPath();
  return { installed: await pathOrSymlinkExists(targetPath) };
}

// ---------------------------------------------------------------------------
// Skills Installation
// ---------------------------------------------------------------------------

function getSkillSyncTargets(): {
  sourceDir: string;
  agentsDir: string;
  claudeDir: string;
  codexDir: string;
} {
  return {
    sourceDir: getBundledSkillsDir(),
    agentsDir: getAgentsSkillsDir(),
    claudeDir: getClaudeSkillsDir(),
    codexDir: getCodexSkillsDir(),
  };
}

export async function installSkills(): Promise<InstallStatus> {
  const targets = getSkillSyncTargets();
  log.info("[integrations] installSkills", targets);

  const result = await syncSkills({
    ...targets,
    skillNames: SKILL_NAMES,
    onSkillError: (skillName, error) => {
      log.warn("[integrations] skill install failed", { skillName, error });
    },
  });

  log.info("[integrations] installSkills done", result);
  return getSkillsInstallStatus();
}

export async function autoUpdateSkillsIfInstalled(): Promise<{
  ran: boolean;
  changedFiles: number;
  processedSkills: number;
}> {
  const targets = getSkillSyncTargets();
  const installedMarker = path.join(targets.agentsDir, "paseo", "SKILL.md");

  try {
    await fs.access(installedMarker);
  } catch {
    return { ran: false, changedFiles: 0, processedSkills: 0 };
  }

  try {
    const result = await syncSkills({
      ...targets,
      skillNames: SKILL_NAMES,
      onSkillError: (skillName, error) => {
        log.warn("[integrations] skill auto-update failed", { skillName, error });
      },
    });
    if (result.changedFiles > 0) {
      log.info("[integrations] auto-updated paseo skills", result);
    } else {
      log.info("[integrations] paseo skills already up to date", result);
    }
    return { ran: true, ...result };
  } catch (error) {
    log.warn("[integrations] auto-update skills aborted", { error });
    return { ran: false, changedFiles: 0, processedSkills: 0 };
  }
}

export async function getSkillsInstallStatus(): Promise<InstallStatus> {
  const claudeDir = getClaudeSkillsDir();
  const accessResults = await Promise.all(
    SKILL_NAMES.map((skillName) =>
      fs
        .access(path.join(claudeDir, skillName, "SKILL.md"))
        .then(() => true)
        .catch(() => false),
    ),
  );
  return { installed: accessResults.every(Boolean) };
}

// React hook that drives the "Install Claude Code runtime" flow for the
// Hubcode provider in Settings → Providers. The Hubcode agent is a thin
// wrapper over Claude Code (see packages/server/src/server/agent/providers/
// hubcode-agent.ts). The desktop app provisions an isolated Claude Code +
// Node.js install at first run; this hook surfaces install state to the
// renderer so the Providers card can show a real "Install" button instead
// of a generic "Not installed" badge.
//
// Progress events: the main process emits "claude-code-install-progress"
// during the install (broadcast from daemon-manager.ts). We subscribe so
// the UI can show a determinate progress bar for the Node download phase
// and human-readable phase labels for the rest.

import { useCallback, useEffect, useState } from "react";
import { invokeDesktopCommand } from "@/desktop/electron/invoke";
import { listenToDesktopEvent } from "@/desktop/electron/events";
import { getIsElectron } from "@/constants/platform";

export interface ClaudeCodeStatus {
  installed: boolean;
  pinnedVersion: string;
  installedVersion: string | null;
  claudeBinary: string;
  nodeBinary: string | null;
}

export type ClaudeCodeInstallPhase =
  | "idle"
  | "checking"
  | "downloading-node"
  | "extracting-node"
  | "installing-claude-code"
  | "complete"
  | "error";

export interface ClaudeCodeInstallProgress {
  phase: ClaudeCodeInstallPhase;
  bytesDownloaded?: number;
  bytesTotal?: number;
  label?: string;
  error?: string;
}

interface UseHubcodeClaudeInstaller {
  /** Last-known install state. null means we haven't queried yet. */
  status: ClaudeCodeStatus | null;
  /** True while a query is in flight. */
  isQuerying: boolean;
  /** True while ensure_claude_code is running. */
  isInstalling: boolean;
  /** Latest progress event broadcast by main. Updates throughout install. */
  progress: ClaudeCodeInstallProgress;
  /** Last error from install (cleared when a new install starts). */
  errorMessage: string | null;
  /** Re-query installed state without triggering an install. */
  refresh: () => Promise<void>;
  /** Trigger ensure_claude_code; resolves after install finishes. */
  install: () => Promise<void>;
  /**
   * Wipe + reinstall. Used as a recovery path when the bundled runtime is
   * broken (e.g. partial npm install, manual deletion). Daemon restarts
   * automatically afterward so live sessions repoint at the fresh binary.
   */
  reinstall: () => Promise<void>;
}

const IDLE_PROGRESS: ClaudeCodeInstallProgress = { phase: "idle" };

export function useHubcodeClaudeInstaller(): UseHubcodeClaudeInstaller {
  const [status, setStatus] = useState<ClaudeCodeStatus | null>(null);
  const [isQuerying, setIsQuerying] = useState(false);
  const [isInstalling, setIsInstalling] = useState(false);
  const [progress, setProgress] = useState<ClaudeCodeInstallProgress>(IDLE_PROGRESS);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!getIsElectron()) return;
    setIsQuerying(true);
    try {
      const next = await invokeDesktopCommand<ClaudeCodeStatus>("get_claude_code_status");
      setStatus(next);
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setIsQuerying(false);
    }
  }, []);

  const install = useCallback(async () => {
    if (!getIsElectron()) return;
    setIsInstalling(true);
    setErrorMessage(null);
    setProgress({ phase: "checking" });
    try {
      const next = await invokeDesktopCommand<ClaudeCodeStatus>("ensure_claude_code");
      setStatus(next);
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setIsInstalling(false);
    }
  }, []);

  const reinstall = useCallback(async () => {
    if (!getIsElectron()) return;
    setIsInstalling(true);
    setErrorMessage(null);
    setProgress({ phase: "checking" });
    try {
      const next = await invokeDesktopCommand<ClaudeCodeStatus>("reinstall_claude_code");
      setStatus(next);
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setIsInstalling(false);
    }
  }, []);

  // Subscribe to progress broadcasts. Both the in-app Install button AND the
  // background install at boot push to the same channel — so this hook
  // accurately reflects whichever flow is currently running.
  useEffect(() => {
    if (!getIsElectron()) return;
    let unlisten: (() => void) | null = null;
    void listenToDesktopEvent<ClaudeCodeInstallProgress>(
      "claude-code-install-progress",
      (payload) => {
        setProgress(payload);
        if (payload.phase === "error" && payload.error) {
          setErrorMessage(payload.error);
        }
        if (payload.phase === "complete") {
          // Refresh status so badge flips. Other consumers (Settings Providers
          // panel) re-snapshot on their own when they observe `status.installed`.
          void refresh();
        }
      },
    ).then((un) => {
      unlisten = un;
    });
    return () => {
      unlisten?.();
    };
  }, [refresh]);

  // Query once on mount.
  useEffect(() => {
    void refresh();
  }, [refresh]);

  return {
    status,
    isQuerying,
    isInstalling,
    progress,
    errorMessage,
    refresh,
    install,
    reinstall,
  };
}

/**
 * Map a progress event to the user-facing label shown in the UI. Centralized
 * so the Providers card and the first-run banner stay in lock-step.
 */
export function describeProgress(progress: ClaudeCodeInstallProgress): string {
  if (progress.label) return progress.label;
  switch (progress.phase) {
    case "idle":
      return "";
    case "checking":
      return "Checking installed runtime…";
    case "downloading-node":
      return "Downloading Node.js…";
    case "extracting-node":
      return "Extracting Node.js runtime…";
    case "installing-claude-code":
      return "Installing Claude Code…";
    case "complete":
      return "Ready";
    case "error":
      return progress.error ? `Failed: ${progress.error}` : "Install failed";
  }
}

/** 0..1 fraction for a determinate bar; null if the phase is indeterminate. */
export function progressFraction(progress: ClaudeCodeInstallProgress): number | null {
  if (progress.phase !== "downloading-node") return null;
  const { bytesDownloaded, bytesTotal } = progress;
  if (!bytesDownloaded || !bytesTotal || bytesTotal <= 0) return null;
  return Math.min(1, bytesDownloaded / bytesTotal);
}

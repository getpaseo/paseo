import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type pino from "pino";
import { READ_ONLY_GIT_ENV } from "./checkout-git-utils.js";

const execFileAsync = promisify(execFile);

const BACKGROUND_GIT_FETCH_INTERVAL_MS = 180_000;

type BackgroundGitFetchTarget = {
  repoGitRoot: string;
  cwd: string;
  listeners: Set<() => void>;
  intervalId: NodeJS.Timeout | null;
  fetchInFlight: boolean;
};

export class BackgroundGitFetchManager {
  private readonly logger: pino.Logger;
  private readonly targets = new Map<string, BackgroundGitFetchTarget>();

  constructor(options: { logger: pino.Logger }) {
    this.logger = options.logger.child({ module: "background-git-fetch-manager" });
  }

  async subscribe(
    params: { repoGitRoot: string; cwd: string },
    listener: () => void,
  ): Promise<{ unsubscribe: () => void }> {
    const existingTarget = this.targets.get(params.repoGitRoot);
    if (existingTarget) {
      existingTarget.listeners.add(listener);
      return {
        unsubscribe: () => {
          this.removeListener(params.repoGitRoot, listener);
        },
      };
    }

    const hasOrigin = await this.hasOriginRemote(params.cwd);
    if (!hasOrigin) {
      return { unsubscribe: () => {} };
    }

    const targetAfterProbe = this.targets.get(params.repoGitRoot);
    if (targetAfterProbe) {
      targetAfterProbe.listeners.add(listener);
      return {
        unsubscribe: () => {
          this.removeListener(params.repoGitRoot, listener);
        },
      };
    }

    const target: BackgroundGitFetchTarget = {
      repoGitRoot: params.repoGitRoot,
      cwd: params.cwd,
      listeners: new Set([listener]),
      intervalId: setInterval(() => {
        void this.runFetch(target);
      }, BACKGROUND_GIT_FETCH_INTERVAL_MS),
      fetchInFlight: false,
    };
    this.targets.set(params.repoGitRoot, target);
    void this.runFetch(target);

    return {
      unsubscribe: () => {
        this.removeListener(params.repoGitRoot, listener);
      },
    };
  }

  dispose(): void {
    for (const target of this.targets.values()) {
      this.closeTarget(target);
    }
    this.targets.clear();
  }

  private closeTarget(target: BackgroundGitFetchTarget): void {
    if (target.intervalId) {
      clearInterval(target.intervalId);
      target.intervalId = null;
    }
    target.listeners.clear();
  }

  private removeListener(targetKey: string, listener: () => void): void {
    const target = this.targets.get(targetKey);
    if (!target) {
      return;
    }

    target.listeners.delete(listener);
    if (target.listeners.size > 0) {
      return;
    }

    this.closeTarget(target);
    this.targets.delete(targetKey);
  }

  private async hasOriginRemote(cwd: string): Promise<boolean> {
    try {
      await execFileAsync("git", ["remote", "get-url", "origin"], {
        cwd,
        env: {
          ...READ_ONLY_GIT_ENV,
          GIT_TERMINAL_PROMPT: "0",
        },
      });
      return true;
    } catch {
      return false;
    }
  }

  private async runFetch(target: BackgroundGitFetchTarget): Promise<void> {
    if (target.fetchInFlight) {
      return;
    }

    target.fetchInFlight = true;
    this.logger.debug(
      { repoGitRoot: target.repoGitRoot, cwd: target.cwd },
      "Running background git fetch",
    );

    try {
      await execFileAsync("git", ["fetch", "origin", "--prune"], {
        cwd: target.cwd,
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: "0",
        },
      });
    } catch (error) {
      this.logger.warn(
        { err: error, repoGitRoot: target.repoGitRoot, cwd: target.cwd },
        "Background git fetch failed",
      );
    } finally {
      target.fetchInFlight = false;
      for (const listener of target.listeners) {
        listener();
      }
    }
  }
}

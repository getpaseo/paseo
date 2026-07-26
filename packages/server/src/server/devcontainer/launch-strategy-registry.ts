import type { Logger } from "pino";
import type { ProcessLaunchStrategy } from "./launch-strategy.js";
import { LocalLaunchStrategy } from "./launch-strategy.js";
import type { ExecutionHandle, LaunchStrategyFactory } from "./container-backend.js";

export type { LaunchStrategyFactory };

/**
 * LaunchStrategyRegistry — resolves the ProcessLaunchStrategy for a given
 * workspace. A workspace with a running isolated environment gets a
 * backend-specific strategy; all others get LocalLaunchStrategy. Probe
 * containers never enter it — they are addressed by the caller that made them.
 *
 * The registry is backend-agnostic: it receives a strategy factory from
 * the active backend and uses it to create strategies when environments
 * are activated. Adding a new backend does not require changing this registry.
 *
 * Containers are keyed by workspaceId rather than by workspace folder, so two
 * workspaces that share a cwd keep independent containers and the registry
 * stays free of path resolution.
 *
 * Every caller uses `awaitStrategy`: a container that is still starting must
 * not send the process to the host in the meantime, so the call blocks until
 * the container is ready and rejects if it never arrives.
 */

/**
 * The workspace wants a container and there isn't one running. Distinct from a
 * failure: agent and terminal creation refuse (they would otherwise run
 * outside the container the user asked for), while a catalog refresh reports
 * the providers as unavailable rather than as errors — the container's tool
 * list is simply unknown until it starts.
 */
export class ContainerNotRunningError extends Error {
  constructor(readonly workspaceKey: string) {
    super("The workspace's container is not running");
    this.name = "ContainerNotRunningError";
  }
}

export interface LaunchStrategyRegistry {
  /**
   * Get the launch strategy for a workspace, awaiting any pending container
   * activation. If a container is starting for this workspace, this blocks
   * until it's ready and returns the container strategy. If no container is
   * pending or active, returns the local strategy immediately.
   */
  awaitStrategy(key: string): Promise<ProcessLaunchStrategy>;

  /**
   * Activate isolated execution for a workspace after the backend starts.
   * `workspaceFolder` is forwarded to the strategy factory so the backend
   * can build a strategy that knows the host-side path.
   */
  activateContainer(key: string, workspaceFolder: string, handle: ExecutionHandle): void;

  /**
   * Register a pending container activation. Callers awaiting the strategy
   * will block until `activateContainer` or `deactivateContainer` is called.
   */
  registerPendingActivation(key: string): void;

  /** Deactivate isolated execution (e.g., when the environment is stopped) */
  deactivateContainer(key: string): void;

  /**
   * Resolve a pending activation without activating a container. Used when
   * the user denies container creation — blocked callers fall through to
   * the local strategy.
   */
  resolvePendingActivation(key: string): void;

  /** Check whether a workspace currently has an active isolated strategy */
  hasContainerStrategy(key: string): boolean;

  /** Check whether a workspace has a pending (in-flight) container activation */
  isPendingActivation(key: string): boolean;
}

interface PendingActivation {
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: Error) => void;
}

export function createLaunchStrategyRegistry(deps: {
  logger: Logger;
  /** Factory provided by the active backend to create strategies */
  createStrategy: LaunchStrategyFactory;
}): LaunchStrategyRegistry {
  const logger = deps.logger.child({ module: "launch-strategy-registry" });
  const localStrategy = new LocalLaunchStrategy();
  const isolatedStrategies = new Map<string, ProcessLaunchStrategy>();
  const pendingActivations = new Map<string, PendingActivation>();

  return {
    async awaitStrategy(key: string): Promise<ProcessLaunchStrategy> {
      const existing = isolatedStrategies.get(key);
      if (existing) return existing;

      const pending = pendingActivations.get(key);
      if (pending) {
        // Wait for the container to finish starting. If it fails, propagate
        // the error so agent/terminal creation fails rather than silently
        // falling back to the host.
        await pending.promise;
        const strategy = isolatedStrategies.get(key);
        if (!strategy) {
          throw new Error("Container failed to start");
        }
        return strategy;
      }

      return localStrategy;
    },

    activateContainer(key: string, workspaceFolder: string, handle: ExecutionHandle): void {
      logger.info({ key, identifier: handle.identifier }, "Activating isolated launch strategy");
      isolatedStrategies.set(key, deps.createStrategy(key, workspaceFolder, handle));
      const pending = pendingActivations.get(key);
      if (pending) {
        pending.resolve();
        pendingActivations.delete(key);
      }
    },

    registerPendingActivation(key: string): void {
      if (pendingActivations.has(key) || isolatedStrategies.has(key)) return;
      let resolveFn: () => void = () => {};
      let rejectFn: (error: Error) => void = () => {};
      const promise = new Promise<void>((res, rej) => {
        resolveFn = res;
        rejectFn = rej;
      });
      // A cancelled activation with nobody waiting on it is normal (the
      // container starts in the background). Without this the rejection would
      // surface as an unhandled promise rejection and take the daemon down.
      promise.catch(() => undefined);
      pendingActivations.set(key, { promise, resolve: resolveFn, reject: rejectFn });
    },

    deactivateContainer(key: string): void {
      if (isolatedStrategies.delete(key)) {
        logger.info({ key }, "Deactivated isolated launch strategy");
      }
      const pending = pendingActivations.get(key);
      if (pending) {
        pending.reject(new Error("Container activation was cancelled"));
        pendingActivations.delete(key);
      }
    },

    resolvePendingActivation(key: string): void {
      const pending = pendingActivations.get(key);
      if (pending) {
        pending.resolve();
        pendingActivations.delete(key);
      }
    },

    hasContainerStrategy(key: string): boolean {
      return isolatedStrategies.has(key);
    },

    isPendingActivation(key: string): boolean {
      return pendingActivations.has(key);
    },
  };
}

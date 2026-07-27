import type { ProcessLaunchStrategy } from "./launch-strategy.js";

/**
 * ContainerBackend — the generic interface for container/sandbox execution
 * backends. The daemon uses this to create, manage, and tear down isolated
 * execution environments for workspaces.
 *
 * The current implementation is DevContainerBackend (shells out to the
 * @devcontainers/cli). The interface is designed so alternative backends
 * (Podman, Kubernetes, microVMs, Nix devshells) can be added without
 * changing the process-launch strategy or any consumer code.
 *
 * The interface is intentionally minimal: it covers lifecycle (up/stop),
 * availability, config detection, and handle retrieval. Everything else
 * (Features, merge logic, variable substitution, lifecycle scripts) is
 * handled inside the backend implementation.
 */

/**
 * Builds the strategy that execs into a running environment. Backends provide
 * one so nothing outside this directory needs to know how they exec.
 *
 * `key` is the container's identity, `workspaceFolder` the host-side path.
 */
export type LaunchStrategyFactory = (
  key: string,
  workspaceFolder: string,
  handle: ExecutionHandle,
) => ProcessLaunchStrategy;

/** A handle to a running execution environment (container, pod, VM, etc.). */
export interface ExecutionHandle {
  /** Opaque identifier for the running environment (container ID, pod name, VM ID) */
  identifier: string;
  /** User to run processes as inside the environment */
  remoteUser: string;
  /** Workspace folder path inside the environment */
  remoteWorkspaceFolder: string;
  /**
   * Address that routes back to the host from inside the environment (the
   * container's default gateway). Absent when the backend could not determine
   * one — daemon-hosted endpoints are then unreachable from the environment.
   */
  hostGatewayAddress?: string;
}

/** Metadata about a running container, for display in the UI. */
export interface ContainerInfo {
  /** Backend that manages this container (e.g. "devcontainer") */
  backend: string;
  /** Human-readable backend name (e.g. "Dev Container") */
  backendLabel: string;
  /** Container ID (short form for display) */
  containerId: string;
  /** Container name (e.g. "frosty_blackburn") */
  containerName: string;
  /** Image name (e.g. "registry.fedoraproject.org/fedora:44") */
  image: string;
  /** ISO 8601 timestamp when the container started */
  startedAt: string;
  /** User running inside the container */
  remoteUser: string;
}

/**
 * Who a container belongs to. Workspace containers persist and are adopted
 * across daemon restarts; probe containers are scratch and are removed when
 * the probe ends, or reaped on the next daemon start if it didn't.
 */
export type ContainerOwnerKind = "workspace" | "probe";

/**
 * Identifies one environment. The key is the container's identity — stamped on
 * the container so it can be found again — and the workspace folder is what the
 * backend hands to the container runtime for config discovery and mounting.
 */
export interface ContainerRef {
  /**
   * Identity for this container: the workspaceId for a workspace container, a
   * unique `probe:<id>` for a probe. Backends use it as the handle-map key and
   * stamp it on the container, so the two can never disagree.
   */
  key: string;
  /** Whether this container is a workspace's or a throwaway probe's. */
  kind: ContainerOwnerKind;
  /**
   * Host-side workspace folder (the bind-mount source). Used to discover
   * devcontainer.json and passed as `--workspace-folder` to the CLI.
   */
  workspaceFolder: string;
}

export interface ContainerUpOptions extends ContainerRef {
  /** Called with each line of build/up output as it is produced */
  onProgress?: (line: string) => void;
  /** Aborts the underlying CLI run (probe cancelled, client disconnected) */
  signal?: AbortSignal;
  /**
   * Whether the workspace folder is a linked git worktree, which the caller
   * already knows from the workspace record. Such a workspace keeps its git
   * directory outside the folder, so the backend has to mount that too or the
   * agent's own git finds no repository at all.
   */
  isWorktree?: boolean;
}

export interface ContainerStopOptions {
  /** Delete the container after stopping it. Probe containers must not linger. */
  remove?: boolean;
}

export interface ContainerBackend {
  /** Unique identifier for this backend (e.g. "devcontainer", "podman") */
  readonly id: string;

  /** Human-readable name for this backend, shown in the backend picker */
  readonly label: string;

  /** Check whether this backend's CLI and runtime are available on this host */
  isAvailable(): Promise<boolean>;

  /** Check whether a config file exists for the given workspace folder */
  hasConfig(workspaceFolder: string): boolean;

  /** Create and start an environment for the workspace, running lifecycle scripts */
  up(options: ContainerUpOptions): Promise<ExecutionHandle>;

  /** Stop the environment for a workspace, including one this daemon adopted. */
  stop(ref: ContainerRef, options?: ContainerStopOptions): Promise<void>;

  /** Get the handle for a running environment, or null if not running */
  getHandle(key: string): ExecutionHandle | null;

  /**
   * Metadata about the running container, for display in the UI. Captured when
   * the container starts and served from memory: a workspace descriptor is
   * rebuilt on every workspace update, so this cannot cost a runtime query.
   * Null when this key has no running container.
   */
  getContainerInfo(key: string): ContainerInfo | null;

  /**
   * Restart the environment for a workspace — stop the running container and
   * start it again with the same config. Use this when the user wants to
   * restart the container process without rebuilding from scratch.
   */
  restart(options: ContainerUpOptions): Promise<ExecutionHandle>;

  /**
   * Rebuild the environment for a workspace — stop the existing container,
   * remove it, and run `up` again with the current config. Use this when
   * the devcontainer.json has changed and the user approved a rebuild.
   */
  rebuild(options: ContainerUpOptions): Promise<ExecutionHandle>;

  /**
   * Compute a hash of the current config file for the workspace. Used to
   * detect config changes by comparing against a previously persisted hash.
   * Returns null if no config exists.
   */
  getConfigHash(workspaceFolder: string): string | null;

  /**
   * Check whether a container is already running for this workspace (e.g.
   * from a previous daemon session). Used on startup to decide whether to
   * reuse an existing container or start fresh.
   */
  isAlreadyRunning(ref: ContainerRef): Promise<boolean>;

  /**
   * Remove probe containers left behind by a previous daemon run. Probes are
   * scratch by construction, so anything still labelled as one at startup is
   * garbage. Returns how many were removed.
   */
  removeAbandonedProbeContainers(): Promise<number>;

  /** Build the launch strategy that execs into one of this backend's handles. */
  createStrategy: LaunchStrategyFactory;
}

import { resolve } from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import type { Logger } from "pino";
import { execCommand } from "../../utils/spawn.js";
import {
  executableExists,
  isCommandAvailable,
} from "../../executable-resolution/executable-resolution.js";
import { discoverDevContainerConfig } from "./config-discovery.js";
import type {
  ContainerBackend,
  ContainerInfo,
  ContainerRef,
  ContainerStopOptions,
  ContainerUpOptions,
  ExecutionHandle,
} from "./container-backend.js";
import { ContainerExecLaunchStrategy } from "./launch-strategy.js";
import type { LaunchStrategyFactory } from "./launch-strategy-registry.js";

/**
 * DevContainerBackend — manages dev container lifecycle by shelling out to
 * the @devcontainers/cli reference implementation (the `devcontainer` binary).
 *
 * The CLI handles all spec complexity: Features, image metadata merge, variable
 * substitution, Docker Compose, UID/GID sync, lifecycle scripts, and user/env
 * probing. This backend is a thin wrapper that maps Paseo workspace concepts
 * onto the CLI's up/stop commands.
 *
 * See: https://containers.dev/implementors/spec/
 * See: https://github.com/devcontainers/cli
 */

/**
 * Identity labels. Passing `--id-label` replaces the set the CLI would infer
 * from the workspace folder, so the folder labels are re-supplied verbatim —
 * other devcontainer tooling (and our own folder queries) still recognise the
 * container — and Paseo's own labels are added alongside.
 *
 * `paseo.container` is what makes the in-memory key and the container's real
 * identity the same thing: two workspaces sharing a cwd get two containers, and
 * a probe can never adopt (or stop) a workspace's container.
 */
const LOCAL_FOLDER_LABEL = "devcontainer.local_folder";
const CONFIG_FILE_LABEL = "devcontainer.config_file";
const CONTAINER_KEY_LABEL = "paseo.container";
const CONTAINER_OWNER_LABEL = "paseo.owner";

/**
 * How long an availability probe is trusted. Docker is routinely started after
 * the daemon, so a negative result must not stick for the whole process life.
 */
const AVAILABILITY_CACHE_MS = 60_000;

/** Ceiling for a single `devcontainer up`; a first build pulls and provisions. */
const CLI_TIMEOUT_MS = 300_000;

interface DevContainerBackendDeps {
  logger: Logger;
  /** Override the devcontainer binary path (defaults to "devcontainer" on PATH) */
  binaryPath?: string;
  /** Override the docker binary path (defaults to "docker" on PATH) */
  dockerBinaryPath?: string;
}

interface DockerInspectResult {
  Name?: string;
  State?: { Running?: boolean; StartedAt?: string };
  Config?: { Image?: string; User?: string };
  NetworkSettings?: {
    Gateway?: string;
    Networks?: Record<string, { Gateway?: string } | undefined>;
  };
}

export function createDevContainerBackend(
  deps: DevContainerBackendDeps,
): ContainerBackend & { createStrategy: LaunchStrategyFactory } {
  const logger = deps.logger.child({ module: "devcontainer-backend" });
  const devcontainerBin = deps.binaryPath ?? resolveDevContainerBinary();
  const dockerBin = deps.dockerBinaryPath ?? "docker";

  // Per-workspace handles, keyed by the opaque workspace key (workspaceId
  // or a synthetic probe key). The workspaceFolder is still used for CLI
  // args and config discovery, but is no longer the map key.
  const handles = new Map<string, ExecutionHandle>();
  // Captured at start time. Workspace descriptors are rebuilt on every workspace
  // update, so the UI's container details cannot be a per-build docker query.
  const containerInfoByKey = new Map<string, ContainerInfo>();
  let availabilityCache: { available: boolean; checkedAt: number } | null = null;

  async function isAvailable(): Promise<boolean> {
    if (availabilityCache && Date.now() - availabilityCache.checkedAt < AVAILABILITY_CACHE_MS) {
      return availabilityCache.available;
    }
    let available: boolean;
    try {
      // A resolved path is checked as a path; a bare name is looked up on
      // PATH. Not with `which`, which is not a command on Windows — a daemon
      // there would report no container backend however much Docker it has.
      const isPath = devcontainerBin.includes("/") || devcontainerBin.includes("\\");
      const devcontainerFound = isPath
        ? executableExists(devcontainerBin) !== null
        : await isCommandAvailable(devcontainerBin);
      available = devcontainerFound && (await isCommandAvailable(dockerBin));
    } catch {
      available = false;
    }
    availabilityCache = { available, checkedAt: Date.now() };
    logger.debug({ available, devcontainerBin, dockerBin }, "Dev container availability check");
    return available;
  }

  function hasConfig(workspaceFolder: string): boolean {
    return discoverDevContainerConfig(workspaceFolder) !== null;
  }

  function getHandle(key: string): ExecutionHandle | null {
    return handles.get(key) ?? null;
  }

  async function inspectContainer(identifier: string): Promise<DockerInspectResult | null> {
    try {
      const result = await execCommand(
        dockerBin,
        ["inspect", "--format", "{{json .}}", identifier],
        { envMode: "internal", timeout: 10_000 },
      );
      return JSON.parse(result.stdout.trim()) as DockerInspectResult;
    } catch {
      return null;
    }
  }

  /**
   * Find a container this key already owns — one left running by a previous
   * daemon, typically. The query is on our identity label, so it can never
   * return a container belonging to another workspace or to a probe.
   */
  async function findRunningContainerId(ref: ContainerRef): Promise<string | null> {
    // Both halves of the identity we stamp on: the key alone would also match a
    // container created for the same key against a different folder.
    return findContainerId(
      [
        `label=${CONTAINER_KEY_LABEL}=${ref.key}`,
        `label=${LOCAL_FOLDER_LABEL}=${resolve(ref.workspaceFolder)}`,
      ],
      { includeStopped: false },
    );
  }

  async function findContainerId(
    filters: string[],
    options: { includeStopped: boolean },
  ): Promise<string | null> {
    const [first] = await listContainerIds(filters, options);
    return first ?? null;
  }

  async function listContainerIds(
    filters: string[],
    options: { includeStopped: boolean },
  ): Promise<string[]> {
    try {
      const result = await execCommand(
        dockerBin,
        [
          "ps",
          "-q",
          // Full IDs, so they compare equal to the ones the CLI reports in its
          // up result — a short ID would silently never match a handle.
          "--no-trunc",
          ...(options.includeStopped ? ["-a"] : []),
          ...filters.flatMap((f) => ["--filter", f]),
        ],
        { envMode: "internal", timeout: 10_000 },
      );
      return result.stdout.trim().split("\n").filter(Boolean);
    } catch {
      return [];
    }
  }

  function buildIdLabelArgs(ref: ContainerRef, configPath: string): string[] {
    if (ref.kind !== "workspace" && ref.kind !== "probe") {
      // The owner label is how the reaper recognises a probe container. A bad
      // one is invisible to it, so the container would leak for good — fail at
      // creation rather than at cleanup time.
      throw new Error(`Container ref ${ref.key} has an invalid kind: ${String(ref.kind)}`);
    }
    return [
      "--id-label",
      `${LOCAL_FOLDER_LABEL}=${resolve(ref.workspaceFolder)}`,
      "--id-label",
      `${CONFIG_FILE_LABEL}=${configPath}`,
      "--id-label",
      `${CONTAINER_KEY_LABEL}=${ref.key}`,
      "--id-label",
      `${CONTAINER_OWNER_LABEL}=${ref.kind}`,
    ];
  }

  /**
   * The address the container reaches the host on. Daemon-hosted endpoints
   * (agent MCP, terminal activity) are only reachable through it, and only
   * when the daemon binds something other than loopback.
   */
  function resolveHostGateway(inspected: DockerInspectResult | null): string | undefined {
    if (!inspected) return undefined;
    const direct = inspected.NetworkSettings?.Gateway;
    if (direct) return direct;
    for (const network of Object.values(inspected.NetworkSettings?.Networks ?? {})) {
      if (network?.Gateway) return network.Gateway;
    }
    return undefined;
  }

  async function up(options: ContainerUpOptions): Promise<ExecutionHandle> {
    const existing = handles.get(options.key);
    if (existing) {
      // A container can stop or be removed out from under us (docker stop, a
      // VS Code rebuild, a machine sleep). A stale handle would send every
      // later exec into a container that no longer exists.
      const inspected = await inspectContainer(existing.identifier);
      if (inspected?.State?.Running) return existing;
      logger.info(
        { key: options.key, identifier: existing.identifier },
        "Cached dev container is no longer running, starting it again",
      );
      handles.delete(options.key);
    }
    return runUp(options, false);
  }

  async function runUp(
    options: ContainerUpOptions,
    removeExisting: boolean,
  ): Promise<ExecutionHandle> {
    const workspaceFolder = resolve(options.workspaceFolder);
    const config = discoverDevContainerConfig(workspaceFolder);
    if (!config) {
      throw new Error(`No devcontainer.json found in ${workspaceFolder}`);
    }

    logger.info(
      { key: options.key, workspaceFolder, configPath: config.configPath },
      removeExisting ? "Rebuilding dev container" : "Starting dev container",
    );

    const args = [
      "up",
      "--workspace-folder",
      workspaceFolder,
      ...buildIdLabelArgs(options, config.configPath),
      "--log-level",
      "info",
    ];
    if (removeExisting) {
      args.push("--remove-existing-container");
    }
    // A linked worktree keeps its git directory outside the workspace folder,
    // so without this the agent's own git finds no repository. The CLI only
    // acts on it when the worktree's links are relative, which is decided when
    // the worktree is created.
    if (options.isWorktree) {
      args.push("--mount-git-worktree-common-dir");
    }

    const result = await runDevContainerCli(args, options);
    const parsed = parseDevContainerUpResult(result.stdout);
    if (!parsed) {
      throw new Error(
        `devcontainer up did not return a valid JSON result: ${result.stderr.slice(-2000)}`,
      );
    }

    const inspected = await inspectContainer(parsed.containerId);
    const gateway = resolveHostGateway(inspected);
    const handle: ExecutionHandle = {
      identifier: parsed.containerId,
      remoteUser: parsed.remoteUser,
      remoteWorkspaceFolder: parsed.remoteWorkspaceFolder,
      ...(gateway ? { hostGatewayAddress: gateway } : {}),
    };

    handles.set(options.key, handle);
    containerInfoByKey.set(options.key, buildContainerInfo(handle, inspected));
    logger.info(
      { workspaceFolder, identifier: handle.identifier, remoteUser: handle.remoteUser },
      "Dev container started",
    );

    return handle;
  }

  /**
   * Run the CLI with its output streamed rather than buffered: a first build
   * pulls an image and runs lifecycle scripts for minutes, and the caller needs
   * to show that as it happens instead of after the fact. stdout is collected
   * whole because the final line is the JSON result.
   */
  function runDevContainerCli(
    args: string[],
    options: Pick<ContainerUpOptions, "onProgress" | "signal">,
  ): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolveRun, rejectRun) => {
      const child = spawn(devcontainerBin, args, {
        env: { ...process.env },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        ...(options.signal ? { signal: options.signal } : {}),
      });

      let stdout = "";
      let stderr = "";
      let stderrLineBuffer = "";
      const timer = setTimeout(() => child.kill(), CLI_TIMEOUT_MS);

      child.stdout?.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        const text = chunk.toString();
        stderr += text;
        if (!options.onProgress) return;
        stderrLineBuffer += text;
        const lines = stderrLineBuffer.split("\n");
        stderrLineBuffer = lines.pop() ?? "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed) options.onProgress(trimmed);
        }
      });

      child.once("error", (error) => {
        clearTimeout(timer);
        rejectRun(new Error(`devcontainer up failed: ${error.message}`, { cause: error }));
      });
      child.once("close", (code) => {
        clearTimeout(timer);
        const trailing = stderrLineBuffer.trim();
        if (trailing) options.onProgress?.(trailing);
        if (code === 0) {
          resolveRun({ stdout, stderr });
          return;
        }
        rejectRun(new Error(`devcontainer up failed: ${stderr.trim().slice(-2000)}`));
      });
    });
  }

  async function stop(ref: ContainerRef, options?: ContainerStopOptions): Promise<void> {
    // Containers outlive the daemon, so the one to stop is not always in the
    // handle map — the identity label finds the container this key owns, and
    // only that one.
    const identifier = handles.get(ref.key)?.identifier ?? (await findRunningContainerId(ref));
    handles.delete(ref.key);
    if (!identifier) {
      if (options?.remove) await removeContainer(ref);
      return;
    }

    logger.info(
      { key: ref.key, identifier, remove: options?.remove === true },
      "Stopping dev container",
    );
    try {
      await execCommand(dockerBin, ["stop", identifier], {
        envMode: "internal",
        timeout: 30_000,
      });
    } catch (error) {
      logger.warn({ err: error, identifier }, "Failed to stop dev container");
    }
    if (options?.remove) await removeContainer(ref);
  }

  /** Delete the container for a key, running or not. */
  async function removeContainer(ref: ContainerRef): Promise<void> {
    const identifiers = await listContainerIds(
      [
        `label=${CONTAINER_KEY_LABEL}=${ref.key}`,
        `label=${LOCAL_FOLDER_LABEL}=${resolve(ref.workspaceFolder)}`,
      ],
      { includeStopped: true },
    );
    for (const identifier of identifiers) {
      try {
        await execCommand(dockerBin, ["rm", "-f", identifier], {
          envMode: "internal",
          timeout: 30_000,
        });
      } catch (error) {
        logger.warn({ err: error, identifier }, "Failed to remove dev container");
      }
    }
  }

  /**
   * Probe containers are scratch: anything still labelled as one when the
   * daemon starts belongs to a probe that never got to clean up (a crash, a
   * kill -9), so it is garbage by definition.
   */
  async function removeAbandonedProbeContainers(): Promise<number> {
    if (!(await isAvailable())) return 0;
    const identifiers = await listContainerIds([`label=${CONTAINER_OWNER_LABEL}=probe`], {
      includeStopped: true,
    });
    let removed = 0;
    for (const identifier of identifiers) {
      try {
        await execCommand(dockerBin, ["rm", "-f", identifier], {
          envMode: "internal",
          timeout: 30_000,
        });
        removed += 1;
        // A handle that outlives its container would report a running
        // environment and send execs into nothing.
        for (const [key, handle] of handles) {
          if (handle.identifier !== identifier) continue;
          handles.delete(key);
          containerInfoByKey.delete(key);
        }
      } catch (error) {
        logger.warn({ err: error, identifier }, "Failed to remove abandoned probe container");
      }
    }
    if (removed > 0) {
      logger.info({ removed }, "Removed abandoned probe containers");
    }
    return removed;
  }

  async function restart(options: ContainerUpOptions): Promise<ExecutionHandle> {
    await stop(options);
    logger.info(
      { key: options.key, workspaceFolder: options.workspaceFolder },
      "Restarting dev container",
    );
    return runUp(options, false);
  }

  async function rebuild(options: ContainerUpOptions): Promise<ExecutionHandle> {
    await stop(options);
    logger.info(
      { key: options.key, workspaceFolder: options.workspaceFolder },
      "Rebuilding dev container",
    );
    return runUp(options, true);
  }

  function getConfigHash(workspaceFolder: string): string | null {
    const config = discoverDevContainerConfig(workspaceFolder);
    if (!config) return null;
    try {
      const content = readFileSync(config.configPath, "utf-8");
      return createHash("sha256").update(content).digest("hex");
    } catch {
      return null;
    }
  }

  async function isAlreadyRunning(ref: ContainerRef): Promise<boolean> {
    // If we already have an in-memory handle for this key, the container is
    // running from this session.
    if (handles.has(ref.key)) return true;
    return (await findRunningContainerId(ref)) !== null;
  }

  function getContainerInfo(key: string): ContainerInfo | null {
    return containerInfoByKey.get(key) ?? null;
  }

  /**
   * Strategy factory: describes how to exec into the container with `docker
   * exec`. A Podman backend would emit `podman exec`, a Kubernetes backend
   * `kubectl exec ... --`; the strategy itself stays runtime-agnostic.
   */
  const createStrategy: LaunchStrategyFactory = (_key, workspaceFolder, handle) =>
    new ContainerExecLaunchStrategy({
      command: dockerBin,
      leadingArgs: ["exec"],
      // -i keeps stdin attached: agent processes are driven over stdin, and
      // without it they see EOF immediately and exit before producing output.
      optionArgs: ["-i", "-u", handle.remoteUser],
      targetArgs: [handle.identifier],
      workdirFlag: "-w",
      envFlag: "-e",
      ttyArgs: ["-t"],
      hostWorkspaceFolder: workspaceFolder,
      remoteWorkspaceFolder: handle.remoteWorkspaceFolder,
      ...(handle.hostGatewayAddress ? { hostGatewayAddress: handle.hostGatewayAddress } : {}),
    });

  return {
    id: DEVCONTAINER_BACKEND_ID,
    label: DEVCONTAINER_BACKEND_LABEL,
    isAvailable,
    hasConfig,
    up,
    stop,
    getHandle,
    getContainerInfo,
    restart,
    rebuild,
    getConfigHash,
    isAlreadyRunning,
    removeAbandonedProbeContainers,
    createStrategy,
  };
}

const DEVCONTAINER_BACKEND_ID = "devcontainer";
const DEVCONTAINER_BACKEND_LABEL = "Dev Container";

/** What the UI shows about a running container, from the CLI result + inspect. */
function buildContainerInfo(
  handle: ExecutionHandle,
  inspected: DockerInspectResult | null,
): ContainerInfo {
  return {
    backend: DEVCONTAINER_BACKEND_ID,
    backendLabel: DEVCONTAINER_BACKEND_LABEL,
    containerId: handle.identifier.slice(0, 12),
    containerName: inspected?.Name?.replace(/^\//, "") ?? handle.identifier.slice(0, 12),
    image: inspected?.Config?.Image ?? "unknown",
    startedAt: inspected?.State?.StartedAt ?? new Date().toISOString(),
    remoteUser: inspected?.Config?.User || handle.remoteUser || "root",
  };
}

interface DevContainerUpResult {
  outcome: string;
  containerId: string;
  remoteUser: string;
  remoteWorkspaceFolder: string;
}

function parseDevContainerUpResult(stdout: string): DevContainerUpResult | null {
  const lines = stdout.trim().split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(line);
      if (
        parsed.outcome === "success" &&
        typeof parsed.containerId === "string" &&
        typeof parsed.remoteUser === "string" &&
        typeof parsed.remoteWorkspaceFolder === "string"
      ) {
        return parsed;
      }
    } catch {
      // Not JSON — keep scanning backwards
    }
  }
  return null;
}

/**
 * Resolve the devcontainer CLI binary path. Tries the package-installed
 * @devcontainers/cli first (via createRequire so it works regardless of
 * the daemon's cwd or PATH), then falls back to "devcontainer" on PATH.
 */
function resolveDevContainerBinary(): string {
  try {
    const require = createRequire(import.meta.url);
    const cliPath = require.resolve("@devcontainers/cli/devcontainer.js");
    return cliPath;
  } catch {
    return "devcontainer";
  }
}

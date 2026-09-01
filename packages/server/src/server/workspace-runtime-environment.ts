import { createHash } from "node:crypto";
import net from "node:net";
import type { PaseoServicePortAllocation } from "@getpaseo/protocol/paseo-config-schema";
import { findFreePort } from "./service-proxy.js";
import { allocateWorkspaceServicePort } from "./workspace-service-port-allocator.js";

const DEFAULT_WORKSPACE_PORT_BLOCK_SIZE = 100;
const MAX_WORKSPACE_PORT_BLOCK_ALLOCATION_ATTEMPTS = 50;
const MIN_TCP_PORT = 1;
const MAX_TCP_PORT = 65_535;

export interface WorkspaceRuntimeEnvironment {
  portBase: number;
  portEnd: number;
  portCount: number;
  composeProjectName: string;
  env: Record<string, string>;
  reservedPorts: ReadonlySet<number>;
}

export interface EnsureWorkspaceRuntimeEnvironmentInput {
  workspaceId: string;
  cwd: string;
  branchName: string | null;
  allocation: PaseoServicePortAllocation | undefined;
  /** Explicit individual-service ports must remain available outside the block. */
  excludedPorts?: ReadonlySet<number>;
}

export interface WorkspaceRuntimeEnvironmentServiceOptions {
  /** Injectable only to make allocation ordering deterministic in tests. */
  random?: () => number;
  /** Injectable only to make availability checks deterministic in tests. */
  checkPortAvailable?: (port: number) => Promise<boolean>;
}

interface StoredWorkspaceRuntimeEnvironment extends WorkspaceRuntimeEnvironment {
  reservedPorts: Set<number>;
}

/**
 * A daemon-lifetime lease shared by a workspace launch and commands that opt
 * into a workspace port block. The lease is deliberately independent from
 * service definitions, so Compose and host processes use the same values.
 */
export class WorkspaceRuntimeEnvironmentService {
  private readonly environments = new Map<string, StoredWorkspaceRuntimeEnvironment>();
  private readonly pending = new Map<string, Promise<StoredWorkspaceRuntimeEnvironment>>();
  private allocationChain: Promise<void> = Promise.resolve();
  private readonly random: () => number;
  private readonly checkPortAvailable: (port: number) => Promise<boolean>;

  constructor(options: WorkspaceRuntimeEnvironmentServiceOptions = {}) {
    this.random = options.random ?? Math.random;
    this.checkPortAvailable = options.checkPortAvailable ?? checkPortAvailable;
  }

  async ensure(
    input: EnsureWorkspaceRuntimeEnvironmentInput,
  ): Promise<WorkspaceRuntimeEnvironment> {
    const existing = this.environments.get(input.workspaceId);
    if (existing) {
      return cloneEnvironment(existing);
    }

    let pending = this.pending.get(input.workspaceId);
    if (!pending) {
      pending = this.create(input);
      this.pending.set(input.workspaceId, pending);
    }

    try {
      return cloneEnvironment(await pending);
    } finally {
      if (this.pending.get(input.workspaceId) === pending) {
        this.pending.delete(input.workspaceId);
      }
    }
  }

  get(workspaceId: string): WorkspaceRuntimeEnvironment | null {
    const environment = this.environments.get(workspaceId);
    return environment ? cloneEnvironment(environment) : null;
  }

  release(workspaceId: string): void {
    this.environments.delete(workspaceId);
  }

  private async create(
    input: EnsureWorkspaceRuntimeEnvironmentInput,
  ): Promise<StoredWorkspaceRuntimeEnvironment> {
    const releaseAllocationLock = await this.acquireAllocationLock();
    try {
      const portCount = input.allocation?.blockSize ?? DEFAULT_WORKSPACE_PORT_BLOCK_SIZE;
      const base = await this.allocatePortBlock({ ...input, portCount });
      const portEnd = base + portCount - 1;
      const reservedPorts = new Set<number>();
      for (let port = base; port <= portEnd; port += 1) {
        reservedPorts.add(port);
      }

      const composeProjectName = `paseo_${createHash("sha256")
        .update(input.workspaceId)
        .digest("hex")
        .slice(0, 12)}`;
      const environment: StoredWorkspaceRuntimeEnvironment = {
        portBase: base,
        portEnd,
        portCount,
        composeProjectName,
        env: {
          PASEO_WORKSPACE_ID: input.workspaceId,
          PASEO_PORT_BASE: String(base),
          PASEO_PORT_END: String(portEnd),
          PASEO_PORT_COUNT: String(portCount),
          PASEO_COMPOSE_PROJECT_NAME: composeProjectName,
          // Overlay instead of inheriting an ambient value: every unit in this
          // workspace must address the same Compose project.
          COMPOSE_PROJECT_NAME: composeProjectName,
        },
        reservedPorts,
      };
      this.environments.set(input.workspaceId, environment);
      return environment;
    } finally {
      releaseAllocationLock();
    }
  }

  private async acquireAllocationLock(): Promise<() => void> {
    const previous = this.allocationChain;
    let release!: () => void;
    this.allocationChain = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    return release;
  }

  private async allocatePortBlock(
    input: EnsureWorkspaceRuntimeEnvironmentInput & { portCount: number },
  ): Promise<number> {
    const { allocation, portCount } = input;
    if (allocation?.portScript) {
      const base = await allocateWorkspaceServicePort({
        allocation,
        cwd: input.cwd,
        scriptName: "@workspace",
        workspaceId: input.workspaceId,
        branchName: input.branchName,
        reservedPorts: new Set([...this.reservedPorts(), ...(input.excludedPorts ?? [])]),
        portCount,
      });
      this.assertValidBlock(base, portCount, allocation.range, input.excludedPorts);
      if (this.intersectsReservedBlock(base, portCount)) {
        throw new Error(
          `Workspace port script returned an already leased block starting at ${base}`,
        );
      }
      return base;
    }

    if (allocation?.range) {
      const range = parseRange(allocation.range);
      if (range.end - range.start + 1 < portCount) {
        throw new Error(
          `Workspace port block size ${portCount} does not fit in configured range ${allocation.range}`,
        );
      }
      const candidateCount = range.end - range.start - portCount + 2;
      const startOffset = Math.floor(this.random() * candidateCount);
      for (let offset = 0; offset < candidateCount; offset += 1) {
        const base = range.start + ((startOffset + offset) % candidateCount);
        if (await this.isAvailableBlock(base, portCount, input.excludedPorts)) {
          return base;
        }
      }
      throw new Error(`No available workspace port block in configured range ${allocation.range}`);
    }

    for (let attempt = 0; attempt < MAX_WORKSPACE_PORT_BLOCK_ALLOCATION_ATTEMPTS; attempt += 1) {
      const base = await findFreePort();
      if (await this.isAvailableBlock(base, portCount, input.excludedPorts)) {
        return base;
      }
    }
    throw new Error(
      `Could not allocate a contiguous workspace port block after ${MAX_WORKSPACE_PORT_BLOCK_ALLOCATION_ATTEMPTS} attempts`,
    );
  }

  private assertValidBlock(
    base: number,
    portCount: number,
    range: string | undefined,
    excludedPorts: ReadonlySet<number> | undefined,
  ): void {
    const end = base + portCount - 1;
    if (!Number.isInteger(base) || base < MIN_TCP_PORT || end > MAX_TCP_PORT) {
      throw new Error(`Workspace port block ${base}-${end} is outside the TCP port range`);
    }
    if (range) {
      const parsed = parseRange(range);
      if (base < parsed.start || end > parsed.end) {
        throw new Error(`Workspace port block ${base}-${end} is outside configured range ${range}`);
      }
    }
    if (intersectsPorts(base, portCount, excludedPorts)) {
      throw new Error(`Workspace port block ${base}-${end} overlaps an explicit service port`);
    }
  }

  private intersectsReservedBlock(base: number, portCount: number): boolean {
    const end = base + portCount - 1;
    for (const environment of this.environments.values()) {
      if (base <= environment.portEnd && end >= environment.portBase) {
        return true;
      }
    }
    return false;
  }

  private reservedPorts(): Set<number> {
    const ports = new Set<number>();
    for (const environment of this.environments.values()) {
      for (const port of environment.reservedPorts) {
        ports.add(port);
      }
    }
    return ports;
  }

  private async isAvailableBlock(
    base: number,
    portCount: number,
    excludedPorts: ReadonlySet<number> | undefined,
  ): Promise<boolean> {
    if (
      this.intersectsReservedBlock(base, portCount) ||
      intersectsPorts(base, portCount, excludedPorts)
    ) {
      return false;
    }
    this.assertValidBlock(base, portCount, undefined, excludedPorts);
    for (let port = base; port < base + portCount; port += 1) {
      if (!(await this.checkPortAvailable(port))) {
        return false;
      }
    }
    return true;
  }
}

function cloneEnvironment(
  environment: StoredWorkspaceRuntimeEnvironment,
): WorkspaceRuntimeEnvironment {
  return {
    portBase: environment.portBase,
    portEnd: environment.portEnd,
    portCount: environment.portCount,
    composeProjectName: environment.composeProjectName,
    env: { ...environment.env },
    reservedPorts: new Set(environment.reservedPorts),
  };
}

function parseRange(value: string): { start: number; end: number } {
  const [start, end] = value.split("-").map(Number);
  if (
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start < MIN_TCP_PORT ||
    end > MAX_TCP_PORT ||
    start > end
  ) {
    throw new Error(`Invalid workspace port range '${value}'`);
  }
  return { start, end };
}

function intersectsPorts(
  base: number,
  portCount: number,
  ports: ReadonlySet<number> | undefined,
): boolean {
  if (!ports) return false;
  const end = base + portCount - 1;
  for (const port of ports) {
    if (port >= base && port <= end) return true;
  }
  return false;
}

async function checkPortAvailable(port: number): Promise<boolean> {
  return await new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => {
      server.close((error) => resolve(!error));
    });
  });
}

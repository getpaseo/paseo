import { randomUUID } from "node:crypto";

const DEFAULT_LEASE_DURATION_MS = 30_000;

export interface WorkspaceMutationLease {
  workspaceId: string;
  leaseId: string;
  fence: number;
  expiresAt: string;
}

export type WorkspaceMutationAuthorityRejectionCode =
  | "authority_held"
  | "authority_not_found"
  | "lease_mismatch"
  | "owner_mismatch"
  | "fence_mismatch"
  | "lease_expired";

export interface WorkspaceMutationAuthorityRejection {
  ok: false;
  code: WorkspaceMutationAuthorityRejectionCode;
}

export type WorkspaceMutationAuthorityResult<T> =
  | { ok: true; value: T }
  | WorkspaceMutationAuthorityRejection;

interface WorkspaceMutationLeaseRecord extends WorkspaceMutationLease {
  ownerId: string;
  expiresAtMs: number;
}

interface LeaseReference {
  workspaceId: string;
  ownerId: string;
  leaseId: string;
  fence: number;
}

export interface WorkspaceMutationAuthorityOptions {
  leaseDurationMs?: number;
  now?: () => number;
  generateLeaseId?: () => string;
}

export class WorkspaceMutationAuthority {
  private readonly leases = new Map<string, WorkspaceMutationLeaseRecord>();
  private readonly fences = new Map<string, number>();
  private readonly laneTails = new Map<string, Promise<void>>();
  private readonly leaseDurationMs: number;
  private readonly now: () => number;
  private readonly generateLeaseId: () => string;

  constructor(options: WorkspaceMutationAuthorityOptions = {}) {
    this.leaseDurationMs = options.leaseDurationMs ?? DEFAULT_LEASE_DURATION_MS;
    this.now = options.now ?? Date.now;
    this.generateLeaseId = options.generateLeaseId ?? randomUUID;
  }

  acquire(input: {
    workspaceId: string;
    ownerId: string;
  }): Promise<WorkspaceMutationAuthorityResult<WorkspaceMutationLease>> {
    return this.runInWorkspaceLane(input.workspaceId, () => {
      const now = this.now();
      const existing = this.leases.get(input.workspaceId);
      if (existing && existing.expiresAtMs > now) {
        return { ok: false, code: "authority_held" };
      }

      if (existing) {
        this.leases.delete(input.workspaceId);
      }

      const fence = (this.fences.get(input.workspaceId) ?? 0) + 1;
      const expiresAtMs = now + this.leaseDurationMs;
      const record: WorkspaceMutationLeaseRecord = {
        workspaceId: input.workspaceId,
        ownerId: input.ownerId,
        leaseId: this.generateLeaseId(),
        fence,
        expiresAtMs,
        expiresAt: new Date(expiresAtMs).toISOString(),
      };
      this.fences.set(input.workspaceId, fence);
      this.leases.set(input.workspaceId, record);
      return { ok: true, value: this.toLease(record) };
    });
  }

  renew(input: LeaseReference): Promise<WorkspaceMutationAuthorityResult<WorkspaceMutationLease>> {
    return this.runInWorkspaceLane(input.workspaceId, () => {
      const record = this.requireLease(input);
      if (!record.ok) {
        return record;
      }

      const expiresAtMs = this.now() + this.leaseDurationMs;
      const renewed = {
        ...record.value,
        expiresAtMs,
        expiresAt: new Date(expiresAtMs).toISOString(),
      };
      this.leases.set(input.workspaceId, renewed);
      return { ok: true, value: this.toLease(renewed) };
    });
  }

  release(
    input: LeaseReference,
  ): Promise<WorkspaceMutationAuthorityResult<WorkspaceMutationLease>> {
    return this.runInWorkspaceLane(input.workspaceId, () => {
      const record = this.requireLease(input);
      if (!record.ok) {
        return record;
      }

      this.leases.delete(input.workspaceId);
      return { ok: true, value: this.toLease(record.value) };
    });
  }

  commit<T>(
    input: LeaseReference,
    mutation: () => Promise<T>,
  ): Promise<WorkspaceMutationAuthorityResult<T>> {
    return this.runInWorkspaceLane(input.workspaceId, async () => {
      const record = this.requireLease(input);
      if (!record.ok) {
        return record;
      }
      return { ok: true, value: await mutation() };
    });
  }

  private requireLease(
    input: LeaseReference,
  ): WorkspaceMutationAuthorityResult<WorkspaceMutationLeaseRecord> {
    const record = this.leases.get(input.workspaceId);
    if (!record) {
      return { ok: false, code: "authority_not_found" };
    }
    if (record.leaseId !== input.leaseId) {
      return { ok: false, code: "lease_mismatch" };
    }
    if (record.ownerId !== input.ownerId) {
      return { ok: false, code: "owner_mismatch" };
    }
    if (record.fence !== input.fence) {
      return { ok: false, code: "fence_mismatch" };
    }
    if (record.expiresAtMs <= this.now()) {
      this.leases.delete(input.workspaceId);
      return { ok: false, code: "lease_expired" };
    }
    return { ok: true, value: record };
  }

  private toLease(record: WorkspaceMutationLeaseRecord): WorkspaceMutationLease {
    return {
      workspaceId: record.workspaceId,
      leaseId: record.leaseId,
      fence: record.fence,
      expiresAt: record.expiresAt,
    };
  }

  private async runInWorkspaceLane<T>(
    workspaceId: string,
    operation: () => T | Promise<T>,
  ): Promise<T> {
    const previous = this.laneTails.get(workspaceId) ?? Promise.resolve();
    let releaseTurn: () => void = () => {};
    const turn = new Promise<void>((resolve) => {
      releaseTurn = resolve;
    });
    const waitForTurn = previous.catch(() => undefined);
    const tail = waitForTurn.then(() => turn);
    this.laneTails.set(workspaceId, tail);

    await waitForTurn;
    try {
      return await operation();
    } finally {
      releaseTurn();
      if (this.laneTails.get(workspaceId) === tail) {
        this.laneTails.delete(workspaceId);
      }
    }
  }
}

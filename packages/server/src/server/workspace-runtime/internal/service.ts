import type {
  CreateWorkspaceInput,
  BoundWorkspaceRuntime,
  WorkspaceProcess,
  WorkspaceProcessInput,
  WorkspaceRuntimeRecordStore,
  WorkspaceRuntimeService,
  WorkspaceTerminal,
  WorkspaceTerminalInput,
} from "../index.js";
import type {
  WorkspaceDriverProcess,
  WorkspaceDriverCreateInput,
  WorkspaceRuntimeDriver,
} from "../drivers/index.js";
import type {
  WorkspaceFiles,
  WorkspaceFilesSubscription,
  WorkspaceWatchEvent,
} from "@getpaseo/workspace-helper";
import { bindWorkspaceHelper, type WorkspaceFilesOwner } from "@getpaseo/workspace-helper";
import { PaseoConfigSchema } from "@getpaseo/protocol/paseo-config-schema";
import {
  createGitCommonObservationCoordinator,
  type ObservationRebindTransaction,
} from "../git-observation/internal/integration.js";
import { findFreePort } from "../../service-proxy.js";

const gracefulStopMilliseconds = 1_000;
const forcedStopMilliseconds = 1_000;

export function createService(
  drivers: readonly WorkspaceRuntimeDriver[],
  records: WorkspaceRuntimeRecordStore,
  catalogMetadata: ReadonlyMap<string, { builtin: boolean; label?: string }> = new Map(),
): WorkspaceRuntimeService {
  const driversById = new Map(drivers.map((driver) => [driver.id, driver]));
  const processesByWorkspaceId = new Map<string, Set<WorkspaceDriverProcess>>();
  const workspaceTails = new Map<string, Promise<void>>();
  const fileClients = new Map<string, { runtimeId: string; client: WorkspaceFilesOwner }>();
  const boundFiles = new Map<string, WorkspaceFiles>();
  const fileSubscriptions = new Map<
    string,
    Set<{
      input: Parameters<WorkspaceFiles["subscribe"]>[0];
      listener: (event: WorkspaceWatchEvent) => void;
      bound: WorkspaceFilesSubscription | null;
    }>
  >();
  const unavailableFiles = new Map<string, "paused" | "recovering" | "destroyed">();
  const boundRuntimes = new Map<string, { runtimeId: string; runtime: BoundWorkspaceRuntime }>();
  const setupAugmentations = new Map<string, Readonly<Record<string, string>>>();
  const gitCommonObservations = createGitCommonObservationCoordinator();

  function requireRegistered(runtimeId: string): WorkspaceRuntimeDriver {
    const driver = driversById.get(runtimeId);
    if (!driver) throw new Error(`Workspace runtime is not registered: ${runtimeId}`);
    return driver;
  }

  async function resolve(workspaceId: string): Promise<WorkspaceRuntimeDriver> {
    const runtimeId = await records.resolveRuntimeId(workspaceId);
    if (!runtimeId) throw new Error(`Workspace runtime is not selected: ${workspaceId}`);
    return requireRegistered(runtimeId);
  }

  async function runWithDriver(
    driver: WorkspaceRuntimeDriver,
    input: WorkspaceProcessInput,
  ): Promise<WorkspaceProcess> {
    assertWorkspaceAvailable(input.workspaceId);
    const inspection = await driver.inspect(input.workspaceId);
    if (inspection.status !== "ready") {
      throw new Error(`Workspace runtime is ${inspection.status}: ${input.workspaceId}`);
    }
    const runtimeProcess = await driver.spawn({
      ...input,
      env: {
        ...(input.purpose.kind === "setup" ? driver.setupEnvironment?.() : {}),
        ...input.env,
        ...(input.purpose.kind === "setup" || driver.provider.environment === "isolated"
          ? inspection.state.lifecycleEnvironment
          : {}),
        ...(input.purpose.kind === "setup" ? setupAugmentations.get(input.workspaceId) : {}),
      },
      stdio: { kind: "pipes" },
    });
    if (runtimeProcess.kind !== "pipes") {
      throw new Error(`Workspace runtime returned PTY mode for a pipe launch: ${driver.id}`);
    }
    trackProcess(input.workspaceId, runtimeProcess);
    return runtimeProcess;
  }

  async function openTerminalWithDriver(
    driver: WorkspaceRuntimeDriver,
    input: WorkspaceTerminalInput,
  ): Promise<WorkspaceTerminal> {
    assertWorkspaceAvailable(input.workspaceId);
    const inspection = await driver.inspect(input.workspaceId);
    if (inspection.status !== "ready") {
      throw new Error(`Workspace runtime is ${inspection.status}: ${input.workspaceId}`);
    }
    const runtimeProcess = await driver.spawn({
      ...input,
      env: {
        ...input.env,
        ...(driver.provider.environment === "isolated"
          ? inspection.state.lifecycleEnvironment
          : {}),
      },
      stdio: { kind: "pty", rows: input.rows, cols: input.cols, term: input.term },
    });
    if (runtimeProcess.kind !== "pty") {
      throw new Error(`Workspace runtime does not support PTY mode: ${driver.id}`);
    }
    trackProcess(input.workspaceId, runtimeProcess);
    return runtimeProcess;
  }

  return {
    listRuntimes() {
      return drivers.map((driver) => {
        const metadata = catalogMetadata.get(driver.id) ?? { builtin: false };
        return {
          runtimeId: driver.id,
          ...metadata,
          requiresGitProject: driver.requiresGitProject,
        };
      });
    },
    async reconcile() {
      const runtimeRecords = (await records.listRuntimeRecords?.()) ?? [];
      const failures: unknown[] = [];
      const reconciledDomains = new Set<string>();
      for (const driver of drivers) {
        const domainId = driver.reconciliationDomainId ?? driver.id;
        if (reconciledDomains.has(domainId)) continue;
        reconciledDomains.add(domainId);
        try {
          await driver.reconcile?.(
            runtimeRecords
              .filter(
                (record) =>
                  (driversById.get(record.runtimeId)?.reconciliationDomainId ??
                    record.runtimeId) === domainId,
              )
              .map((record) => record.workspaceId),
          );
        } catch (error) {
          failures.push(error);
        }
      }
      for (const record of runtimeRecords) {
        try {
          await sequence(record.workspaceId, async () => {
            const driver = requireRegistered(record.runtimeId);
            if (record.deleting) {
              await finishDestroy(record.workspaceId, driver);
              return;
            }
            const inspection = await driver.inspect(record.workspaceId);
            if (inspection.status === "missing" || inspection.status === "error") return;
            await records.persistRuntimeId(
              record.workspaceId,
              record.runtimeId,
              inspection.placement,
            );
            if (record.archived && inspection.status === "ready") {
              await pauseWithDriver(record.workspaceId, driver);
            } else if (!record.archived && inspection.status === "paused") {
              unavailableFiles.set(record.workspaceId, "recovering");
              await driver.resume(record.workspaceId);
              const rebind = await stageSubscriptionRebind(record.workspaceId, true);
              await rebind.commit();
              unavailableFiles.delete(record.workspaceId);
            }
          });
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length > 0)
        throw new AggregateError(failures, "Workspace reconciliation failed");
    },
    async close() {
      const workspaceIds = new Set([
        ...processesByWorkspaceId.keys(),
        ...fileClients.keys(),
        ...fileSubscriptions.keys(),
        ...boundRuntimes.keys(),
      ]);
      boundRuntimes.clear();
      await Promise.all(
        [...fileSubscriptions.values()].flatMap((subscriptions) =>
          [...subscriptions].map(async (subscription) => {
            await subscription.bound?.unsubscribe();
            subscription.bound = null;
          }),
        ),
      );
      await gitCommonObservations.close();
      await Promise.all(
        [...workspaceIds].map((workspaceId) => closeFiles(workspaceId, true, null)),
      );
      await Promise.all([...workspaceIds].map((workspaceId) => stopProcesses(workspaceId)));
    },
    async create(input) {
      return sequence(input.workspaceId, async () => {
        const selectedRuntimeId = await records.resolveRuntimeId(input.workspaceId);
        if (selectedRuntimeId && selectedRuntimeId !== input.runtimeId) {
          throw new Error(
            `Workspace runtime is already selected as ${selectedRuntimeId}: ${input.workspaceId}`,
          );
        }
        const driver = requireRegistered(input.runtimeId);
        const before = await driver.inspect(input.workspaceId);
        let ownsNewResource = false;
        try {
          const ready = await driver.create(toDriverCreateInput(input));
          ownsNewResource = before.status === "missing";
          if (ready.state.lifecycle === "ready") {
            const helper = bindWorkspaceHelper({
              command: driver.workspaceHelper.command,
              launch: (argv) => launchHelper(driver, input.workspaceId, argv),
            });
            try {
              await helper.verify();
            } finally {
              await helper.close();
            }
          }
          await records.persistRuntimeId(input.workspaceId, input.runtimeId, ready.placement);
          if (ready.materializedFreshContent && input.purpose !== "provider-probe") {
            setupAugmentations.set(input.workspaceId, {
              PASEO_WORKTREE_PORT: String(await findFreePort()),
            });
          }
          unavailableFiles.delete(input.workspaceId);
          return {
            workspaceId: input.workspaceId,
            runtimeId: input.runtimeId,
            ...ready.placement,
            materializedFreshContent: ready.materializedFreshContent,
          };
        } catch (error) {
          if (ownsNewResource) {
            try {
              await stopProcesses(input.workspaceId);
              await driver.destroy(input.workspaceId);
            } catch (cleanupError) {
              throw new Error(`Workspace creation failed before cleanup: ${String(error)}`, {
                cause: cleanupError,
              });
            }
          }
          throw error;
        }
      });
    },
    async run(input) {
      return sequence(input.workspaceId, async () =>
        runWithDriver(await resolve(input.workspaceId), input),
      );
    },
    async openTerminal(input) {
      return sequence(input.workspaceId, async () =>
        openTerminalWithDriver(await resolve(input.workspaceId), input),
      );
    },
    async bind(workspaceId) {
      assertWorkspaceAvailable(workspaceId);
      const driver = await resolve(workspaceId);
      const inspection = await driver.inspect(workspaceId);
      if (inspection.status !== "ready") {
        throw new Error(`Workspace runtime is ${inspection.status}: ${workspaceId}`);
      }
      const cached = boundRuntimes.get(workspaceId);
      if (cached?.runtimeId === driver.id) {
        return cached.runtime;
      }
      const runtime: BoundWorkspaceRuntime = {
        run: (input) => runWithDriver(driver, { workspaceId, ...input }),
        resolveCommand: async (command) =>
          (await requireFilesOwner(workspaceId)).resolveCommand(command),
        scriptTerminal: driver.scriptTerminal,
        provider: driver.provider,
        files: bindFiles(workspaceId),
      };
      gitCommonObservations.bind(runtime, workspaceId, driver);
      boundRuntimes.set(workspaceId, {
        runtimeId: driver.id,
        runtime,
      });
      return runtime;
    },
    files(workspaceId) {
      let files = boundFiles.get(workspaceId);
      if (!files) {
        files = bindFiles(workspaceId);
        boundFiles.set(workspaceId, files);
      }
      return files;
    },
    async inspect(workspaceId) {
      const runtimeId = await records.resolveRuntimeId(workspaceId);
      if (!runtimeId) return { status: "missing" };
      const inspection = await requireRegistered(runtimeId).inspect(workspaceId);
      if (inspection.status === "ready" || inspection.status === "paused") {
        return { status: inspection.status, ...inspection.placement };
      }
      return { status: inspection.status };
    },
    async requireHostVisiblePath(workspaceId) {
      const runtimeId = await records.resolveRuntimeId(workspaceId);
      if (!runtimeId) throw new Error(`Workspace runtime is not selected: ${workspaceId}`);
      const inspection = await requireRegistered(runtimeId).inspect(workspaceId);
      if (inspection.status !== "ready" && inspection.status !== "paused") {
        throw new Error(`Workspace runtime is ${inspection.status}: ${workspaceId}`);
      }
      if (!inspection.placement.hostVisiblePath) {
        throw new Error(`Workspace has no host-visible path: ${workspaceId}`);
      }
      return inspection.placement.hostVisiblePath;
    },
    async pause(workspaceId) {
      await sequence(workspaceId, async () => {
        await pauseWithDriver(workspaceId, await resolve(workspaceId));
      });
    },
    async resume(workspaceId) {
      await sequence(workspaceId, async () => {
        unavailableFiles.set(workspaceId, "recovering");
        await (await resolve(workspaceId)).resume(workspaceId);
        const rebind = await stageSubscriptionRebind(workspaceId, true);
        await rebind.commit();
        unavailableFiles.delete(workspaceId);
      });
    },
    async archive(workspaceId, archiveOptions) {
      await sequence(workspaceId, async () => {
        if (!records.archiveWorkspaceRecord) {
          throw new Error("Workspace runtime record store cannot archive workspaces");
        }
        const driver = await resolve(workspaceId);
        const inspection = await driver.inspect(workspaceId);
        if (inspection.status === "ready") await runArchiveHooks(workspaceId, driver);
        await pauseWithDriver(workspaceId, driver);
        if (archiveOptions?.releaseBacking) {
          await driver.releaseBacking?.(workspaceId);
        }
        await records.archiveWorkspaceRecord(workspaceId);
      });
    },
    async restore(workspaceId) {
      await sequence(workspaceId, async () => {
        if (!records.restoreWorkspaceRecord) {
          throw new Error("Workspace runtime record store cannot restore workspaces");
        }
        unavailableFiles.set(workspaceId, "recovering");
        await (await resolve(workspaceId)).resume(workspaceId);
        const rebind = await stageSubscriptionRebind(workspaceId, true);
        try {
          await records.restoreWorkspaceRecord(workspaceId);
          await rebind.commit();
          unavailableFiles.delete(workspaceId);
        } catch (error) {
          await rebind.rollback();
          throw error;
        }
      });
    },
    async destroy(workspaceId) {
      await sequence(workspaceId, async () => {
        const runtimeId = await records.resolveRuntimeId(workspaceId);
        if (!runtimeId) {
          unavailableFiles.delete(workspaceId);
          setupAugmentations.delete(workspaceId);
          return;
        }
        if (!records.beginWorkspaceDeletion || !records.removeWorkspaceRecord) {
          throw new Error("Workspace runtime record store cannot permanently delete workspaces");
        }
        const driver = requireRegistered(runtimeId);
        await records.beginWorkspaceDeletion(workspaceId);
        await finishDestroy(workspaceId, driver);
      });
    },
  };

  async function finishDestroy(workspaceId: string, driver: WorkspaceRuntimeDriver): Promise<void> {
    unavailableFiles.set(workspaceId, "destroyed");
    boundRuntimes.delete(workspaceId);
    await closeFiles(workspaceId, true);
    await gitCommonObservations.destroy(workspaceId);
    await stopProcesses(workspaceId);
    await driver.destroy(workspaceId);
    if (!records.removeWorkspaceRecord) {
      throw new Error("Workspace runtime record store cannot permanently delete workspaces");
    }
    await records.removeWorkspaceRecord(workspaceId);
    unavailableFiles.delete(workspaceId);
    setupAugmentations.delete(workspaceId);
  }

  async function pauseWithDriver(
    workspaceId: string,
    driver: WorkspaceRuntimeDriver,
  ): Promise<void> {
    unavailableFiles.set(workspaceId, "paused");
    boundRuntimes.delete(workspaceId);
    await closeFiles(workspaceId);
    await gitCommonObservations.pause(workspaceId);
    await stopProcesses(workspaceId);
    await driver.pause(workspaceId);
  }

  async function runArchiveHooks(
    workspaceId: string,
    driver: WorkspaceRuntimeDriver,
  ): Promise<void> {
    const config = await readWorkspaceConfig(workspaceId);
    if (!config) return;
    const inspection = await driver.inspect(workspaceId);
    if (inspection.status !== "ready") {
      throw new Error(`Workspace runtime is ${inspection.status}: ${workspaceId}`);
    }
    const env = {
      ...lifecycleEnvironment(),
      ...inspection.state.lifecycleEnvironment,
    };
    for (const command of config.worktree?.teardown ?? []) {
      const argv = lifecycleShellCommand(command);
      const process = await runWithDriver(driver, {
        workspaceId,
        argv,
        env,
        purpose: { kind: "archive" },
      });
      process.stdin.end();
      const [stdout, stderr, exit] = await Promise.all([
        drainText(process.stdout),
        drainText(process.stderr),
        process.exited,
      ]);
      if (exit.code !== 0 || exit.signal !== null) {
        throw new Error(
          `Workspace archive command failed (${exit.code ?? exit.signal}): ${stderr || stdout}`,
        );
      }
    }
  }

  async function readWorkspaceConfig(workspaceId: string) {
    const files = await requireFiles(workspaceId);
    const stat = await files.stat("paseo.json");
    if (stat.status === "missing") return null;
    if (stat.status === "error") throw new Error(stat.error);
    const file = await files.read("paseo.json");
    const chunks: Buffer[] = [];
    for await (const chunk of file.chunks) chunks.push(Buffer.from(chunk));
    return PaseoConfigSchema.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
  }

  function assertWorkspaceAvailable(workspaceId: string): void {
    const unavailable = unavailableFiles.get(workspaceId);
    if (unavailable) throw new Error(`Workspace runtime is ${unavailable}: ${workspaceId}`);
  }

  function bindFiles(workspaceId: string): WorkspaceFiles {
    return {
      async stat(path) {
        return (await requireFiles(workspaceId)).stat(path);
      },
      async list(path) {
        return (await requireFiles(workspaceId)).list(path);
      },
      async read(path) {
        return (await requireFiles(workspaceId)).read(path);
      },
      async write(input) {
        return (await requireFiles(workspaceId)).write(input);
      },
      async subscribe(input, listener) {
        const logical = { input, listener, bound: null as WorkspaceFilesSubscription | null };
        const subscriptions = fileSubscriptions.get(workspaceId) ?? new Set();
        subscriptions.add(logical);
        fileSubscriptions.set(workspaceId, subscriptions);
        try {
          logical.bound = await (await requireFiles(workspaceId)).subscribe(input, listener);
        } catch (error) {
          subscriptions.delete(logical);
          if (subscriptions.size === 0) fileSubscriptions.delete(workspaceId);
          throw error;
        }
        let active = true;
        return {
          async unsubscribe() {
            if (!active) return;
            active = false;
            subscriptions.delete(logical);
            if (subscriptions.size === 0) fileSubscriptions.delete(workspaceId);
            await logical.bound?.unsubscribe();
            logical.bound = null;
          },
        };
      },
    };
  }

  async function requireFiles(workspaceId: string): Promise<WorkspaceFiles> {
    return (await requireFilesOwner(workspaceId)).files;
  }

  async function requireFilesOwner(
    workspaceId: string,
    allowUnavailable = false,
  ): Promise<WorkspaceFilesOwner> {
    const unavailable = unavailableFiles.get(workspaceId);
    if (unavailable && !allowUnavailable)
      throw new Error(`Workspace runtime is ${unavailable}: ${workspaceId}`);
    const driver = await resolve(workspaceId);
    const inspection = await driver.inspect(workspaceId);
    if (inspection.status !== "ready") {
      throw new Error(`Workspace runtime is ${inspection.status}: ${workspaceId}`);
    }
    const cached = fileClients.get(workspaceId);
    if (cached && cached.runtimeId === driver.id) {
      return cached.client;
    }
    if (cached) await cached.client.close();
    const client = bindWorkspaceHelper({
      command: driver.workspaceHelper.command,
      launch: async (argv) => {
        return launchHelper(driver, workspaceId, argv);
      },
    });
    fileClients.set(workspaceId, {
      runtimeId: driver.id,
      client,
    });
    return client;
  }

  async function closeFiles(
    workspaceId: string,
    forgetSubscriptions = false,
    reason: Error | null = new Error("Workspace files client is closed"),
  ): Promise<void> {
    const cached = fileClients.get(workspaceId);
    fileClients.delete(workspaceId);
    const subscriptions = fileSubscriptions.get(workspaceId);
    if (subscriptions) {
      for (const subscription of subscriptions) subscription.bound = null;
      if (forgetSubscriptions) fileSubscriptions.delete(workspaceId);
    }
    if (cached) await cached.client.close(reason ?? undefined);
  }

  async function stageSubscriptionRebind(
    workspaceId: string,
    allowUnavailable = false,
  ): Promise<ObservationRebindTransaction> {
    const files = await stageFileSubscriptionRebind(workspaceId, allowUnavailable);
    try {
      const git = await gitCommonObservations.stageResume(workspaceId);
      return combineRebindTransactions([files, git]);
    } catch (error) {
      await files.rollback();
      throw error;
    }
  }

  async function stageFileSubscriptionRebind(
    workspaceId: string,
    allowUnavailable = false,
  ): Promise<ObservationRebindTransaction> {
    const subscriptions = fileSubscriptions.get(workspaceId);
    if (!subscriptions || subscriptions.size === 0) return noOpRebindTransaction();
    const files = (await requireFilesOwner(workspaceId, allowUnavailable)).files;
    const staged: Array<{
      logical: typeof subscriptions extends Set<infer T> ? T : never;
      bound: WorkspaceFilesSubscription;
    }> = [];
    try {
      for (const logical of subscriptions) {
        staged.push({
          logical,
          bound: await files.subscribe(logical.input, logical.listener),
        });
      }
    } catch (error) {
      await Promise.allSettled(staged.map(({ bound }) => bound.unsubscribe()));
      throw error;
    }
    let finished = false;
    return {
      async commit() {
        if (finished) return;
        finished = true;
        for (const { logical, bound } of staged) logical.bound = bound;
      },
      async rollback() {
        if (finished) return;
        finished = true;
        await Promise.allSettled(staged.map(({ bound }) => bound.unsubscribe()));
      },
    };
  }

  async function launchHelper(
    driver: WorkspaceRuntimeDriver,
    workspaceId: string,
    argv: readonly [string, ...string[]],
  ) {
    const runtimeProcess = await driver.spawn({
      workspaceId,
      argv,
      env: driver.workspaceHelper.env,
      purpose: { kind: "workspace-helper" },
      stdio: { kind: "pipes" },
    });
    if (runtimeProcess.kind !== "pipes") {
      throw new Error(`Workspace runtime returned PTY mode for its helper: ${driver.id}`);
    }
    trackProcess(workspaceId, runtimeProcess);
    return runtimeProcess;
  }

  async function sequence<T>(workspaceId: string, operation: () => Promise<T>): Promise<T> {
    const previous = workspaceTails.get(workspaceId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolveGate) => {
      release = resolveGate;
    });
    const tail = previous.then(() => gate);
    workspaceTails.set(workspaceId, tail);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (workspaceTails.get(workspaceId) === tail) workspaceTails.delete(workspaceId);
    }
  }

  function trackProcess(workspaceId: string, runtimeProcess: WorkspaceDriverProcess): void {
    const processes = processesByWorkspaceId.get(workspaceId) ?? new Set();
    processes.add(runtimeProcess);
    processesByWorkspaceId.set(workspaceId, processes);
    void runtimeProcess.exited.then(
      () => forgetProcess(workspaceId, runtimeProcess),
      () => forgetProcess(workspaceId, runtimeProcess),
    );
  }

  function forgetProcess(workspaceId: string, runtimeProcess: WorkspaceDriverProcess): void {
    const processes = processesByWorkspaceId.get(workspaceId);
    processes?.delete(runtimeProcess);
    if (processes?.size === 0) processesByWorkspaceId.delete(workspaceId);
  }

  async function stopProcesses(workspaceId: string): Promise<void> {
    const processes = [...(processesByWorkspaceId.get(workspaceId) ?? [])];
    for (const runtimeProcess of processes) runtimeProcess.kill("SIGTERM");
    const graceful = await waitForAll(processes, gracefulStopMilliseconds);
    if (graceful) return;
    for (const runtimeProcess of processes) runtimeProcess.kill("SIGKILL");
    if (!(await waitForAll(processes, forcedStopMilliseconds))) {
      throw new Error(`Workspace processes did not stop: ${workspaceId}`);
    }
  }
}

function combineRebindTransactions(
  transactions: readonly ObservationRebindTransaction[],
): ObservationRebindTransaction {
  let finished = false;
  return {
    async commit() {
      if (finished) return;
      finished = true;
      for (const transaction of transactions) await transaction.commit();
    },
    async rollback() {
      if (finished) return;
      finished = true;
      await Promise.allSettled(transactions.map((transaction) => transaction.rollback()));
    },
  };
}

function noOpRebindTransaction(): ObservationRebindTransaction {
  return { commit: async () => {}, rollback: async () => {} };
}

async function drainText(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (bytes < 64 * 1024) chunks.push(buffer.subarray(0, 64 * 1024 - bytes));
    bytes += buffer.byteLength;
  }
  return Buffer.concat(chunks).toString("utf8").trim();
}

function lifecycleShellCommand(command: string): readonly [string, ...string[]] {
  return process.platform === "win32"
    ? ["powershell.exe", "-NoProfile", "-Command", command]
    : ["/bin/sh", "-c", command];
}

function lifecycleEnvironment(): Readonly<Record<string, string>> {
  if (process.platform === "win32") {
    return { PATH: process.env.PATH ?? "" };
  }
  return { PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin" };
}

function toDriverCreateInput(input: CreateWorkspaceInput): WorkspaceDriverCreateInput {
  return {
    workspaceId: input.workspaceId,
    project: {
      projectId: input.project.id,
      source: input.project.source,
    },
    placement: input.placement,
    ...(input.purpose ? { purpose: input.purpose } : {}),
    ...(input.markFirstAgentBranchAutoName ? { markFirstAgentBranchAutoName: true } : {}),
    ...(input.seedPaseoConfigFrom ? { seedPaseoConfigFrom: input.seedPaseoConfigFrom } : {}),
  };
}

async function waitForAll(
  processes: readonly WorkspaceDriverProcess[],
  timeoutMilliseconds: number,
): Promise<boolean> {
  if (processes.length === 0) return true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMilliseconds);
  });
  const exited = Promise.allSettled(processes.map((runtimeProcess) => runtimeProcess.exited)).then(
    () => true as const,
  );
  const result = await Promise.race([exited, timedOut]);
  if (timer) clearTimeout(timer);
  return result;
}

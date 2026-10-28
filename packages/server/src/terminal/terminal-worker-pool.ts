import type { TerminalActivityState } from "@getpaseo/protocol/terminal-activity";
import type { CaptureTerminalLinesResult } from "./terminal-capture.js";
import type {
  TerminalActivityListener,
  TerminalsChangedListener,
  TerminalWorkspaceContributionChangedListener,
} from "./terminal-manager.js";
import type { TerminalSession, TerminalStateSnapshot } from "./terminal.js";
import type { WorkerCreateTerminalOptions } from "./terminal-worker-protocol.js";
import type { DaemonTerminalManager } from "./worker-terminal-manager.js";

// The daemon's terminal service over up to two terminal workers: the current one, which takes
// every new terminal, and one draining a previous worker protocol, which keeps serving the
// terminals it already runs and is let go once its last one exits. With no current worker (two
// were already running), the first terminal created after one exits starts one. A worker from a
// newer Paseo
// is not driven at all: the service then refuses terminal requests with
// TerminalWorkerIncompatibleError instead of serving a partial view.

export class TerminalWorkerIncompatibleError extends Error {
  readonly code = "terminal_worker_incompatible";
  readonly paseoVersion: string;
  readonly protocolVersion: unknown;

  constructor(input: { paseoVersion: string; protocolVersion: unknown }) {
    super(
      `Terminals are held by a newer Paseo (v${input.paseoVersion}, worker protocol ${String(input.protocolVersion)}). Update Paseo to v${input.paseoVersion} or later to use them, or run \`paseo daemon stop\` to close them.`,
    );
    this.name = "TerminalWorkerIncompatibleError";
    this.paseoVersion = input.paseoVersion;
    this.protocolVersion = input.protocolVersion;
  }
}

export class NoTerminalWorkerAvailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NoTerminalWorkerAvailableError";
  }
}

export interface TerminalWorkerPoolMember {
  manager: DaemonTerminalManager;
  workerPid: number;
  /** Resolves only after confirmed worker death and its scoped cleanup. */
  exited: Promise<void>;
  /** Waits for any reconnect; false once the member is retired or stopping. */
  ready(): Promise<boolean>;
  stopRecovery(): void;
}

export interface TerminalWorkerPoolOptions {
  current: TerminalWorkerPoolMember | null;
  draining: TerminalWorkerPoolMember[];
  /** Set when a worker from a newer Paseo holds this home's terminals. */
  incompatible: TerminalWorkerIncompatibleError | null;
  /**
   * Starts a current worker when there is none. Throws NoTerminalWorkerAvailableError, saying
   * why, while no worker may start.
   */
  startCurrent?: () => Promise<TerminalWorkerPoolMember>;
  /** Closes every terminal of every worker in the home and verifies they ended. */
  closeAll: () => Promise<void>;
  /** A draining worker's last terminal exited and the pool let it go. */
  onDrained?: (member: TerminalWorkerPoolMember) => void;
}

export function createTerminalWorkerPool(
  options: TerminalWorkerPoolOptions,
): DaemonTerminalManager {
  let current = options.current;
  const draining = new Set(options.draining);
  const terminalsChangedListeners = new Set<TerminalsChangedListener>();
  const terminalActivityListeners = new Set<TerminalActivityListener>();
  const contributionListeners = new Set<TerminalWorkspaceContributionChangedListener>();
  let closePromise: Promise<void> | null = null;
  let detached = false;
  // One start at a time, so concurrent creates never launch two workers.
  let starting: Promise<TerminalWorkerPoolMember> | null = null;
  // Registrations belong to the service and are replayed whenever a current worker starts.
  const cwdEnv = new Map<string, Record<string, string>>();

  function members(): TerminalWorkerPoolMember[] {
    return [...(current ? [current] : []), ...draining];
  }

  function assertAvailable(): void {
    if (options.incompatible) throw options.incompatible;
  }

  function ownerOf(terminalId: string): DaemonTerminalManager | null {
    for (const member of members()) {
      if (member.manager.getTerminal(terminalId)) return member.manager;
    }
    return null;
  }

  function routed(terminalId: string): DaemonTerminalManager {
    assertAvailable();
    const owner = ownerOf(terminalId) ?? current?.manager;
    if (!owner) {
      throw new NoTerminalWorkerAvailableError(`Terminal ${terminalId} is not running`);
    }
    return owner;
  }

  function releaseIfDrained(member: TerminalWorkerPoolMember): void {
    if (!draining.has(member) || member.manager.listDirectories().length > 0) return;
    draining.delete(member);
    // With no controller and no terminals the worker exits on its own. The request that closed
    // the last terminal is still waiting for its answer.
    void member.manager
      .detach({ afterPendingRequests: true })
      .then(() => options.onDrained?.(member));
  }

  function forwardEvents(member: TerminalWorkerPoolMember): void {
    void member.exited.then(() => {
      if (current === member) current = null;
      return draining.delete(member);
    });
    member.manager.subscribeTerminalsChanged((event) => {
      for (const listener of Array.from(terminalsChangedListeners)) listener(event);
      releaseIfDrained(member);
    });
    member.manager.subscribeTerminalActivity((event) => {
      for (const listener of Array.from(terminalActivityListeners)) listener(event);
    });
    member.manager.subscribeTerminalWorkspaceContributionChanged((event) => {
      for (const listener of Array.from(contributionListeners)) listener(event);
    });
  }

  for (const member of members()) forwardEvents(member);
  for (const member of Array.from(draining)) releaseIfDrained(member);

  async function currentManager(): Promise<DaemonTerminalManager> {
    if (closePromise || detached)
      throw new NoTerminalWorkerAvailableError("No terminal worker can take new terminals");
    const candidate = current;
    if (candidate && (await candidate.ready())) return candidate.manager;
    const startCurrent = options.startCurrent;
    if (!startCurrent || closePromise || detached) {
      return Promise.reject(
        new NoTerminalWorkerAvailableError("No terminal worker can take new terminals"),
      );
    }
    starting ??= startCurrent()
      .then(async (member) => {
        if (closePromise || detached) {
          // The service closed or let go while the worker started: it takes no terminals.
          member.stopRecovery();
          await member.manager.detach();
          throw new NoTerminalWorkerAvailableError("No terminal worker can take new terminals");
        }
        forwardEvents(member);
        for (const [cwd, env] of cwdEnv) member.manager.registerCwdEnv({ cwd, env });
        current = member;
        return member;
      })
      .finally(() => {
        starting = null;
      });
    return starting.then((member) => member.manager);
  }

  function closeTerminals(): Promise<void> {
    closePromise ??= (async () => {
      for (const member of members()) member.stopRecovery();
      await starting?.catch(() => {});
      await Promise.all(members().map((member) => member.manager.detach()));
      draining.clear();
      await options.closeAll();
    })();
    return closePromise;
  }

  return {
    getUnavailableError(): Error | null {
      return options.incompatible;
    },

    async getTerminals(cwd, filter) {
      assertAvailable();
      const lists = await Promise.all(
        members().map((member) => member.manager.getTerminals(cwd, filter)),
      );
      return lists.flat();
    },

    async createTerminal(
      createOptions: WorkerCreateTerminalOptions & { workspaceId: string },
    ): Promise<TerminalSession> {
      assertAvailable();
      const manager = await currentManager();
      return manager.createTerminal(createOptions);
    },

    registerCwdEnv(registration) {
      cwdEnv.set(registration.cwd, registration.env);
      if (current) current.manager.registerCwdEnv(registration);
    },

    validateTerminalActivityToken(terminalId, token) {
      for (const member of members()) {
        const result = member.manager.validateTerminalActivityToken(terminalId, token);
        if (result !== "unknown") return result;
      }
      return "unknown";
    },

    getTerminal(id) {
      for (const member of members()) {
        const session = member.manager.getTerminal(id);
        if (session) return session;
      }
      return undefined;
    },

    async getTerminalState(id, stateOptions): Promise<TerminalStateSnapshot | null> {
      return routed(id).getTerminalState(id, stateOptions);
    },

    setTerminalTitle(id, title) {
      return ownerOf(id)?.setTerminalTitle(id, title) ?? false;
    },

    async setTerminalActivity(id, state: TerminalActivityState) {
      return (await ownerOf(id)?.setTerminalActivity(id, state)) ?? false;
    },

    async clearTerminalAttention(id) {
      return (await ownerOf(id)?.clearTerminalAttention(id)) ?? false;
    },

    killTerminal(id) {
      ownerOf(id)?.killTerminal(id);
    },

    async killTerminalAndWait(id, waitOptions) {
      await routed(id).killTerminalAndWait(id, waitOptions);
    },

    async captureTerminal(id, captureOptions): Promise<CaptureTerminalLinesResult> {
      return routed(id).captureTerminal(id, captureOptions);
    },

    listDirectories() {
      return [...new Set(members().flatMap((member) => member.manager.listDirectories()))];
    },

    killAll() {
      void closeTerminals().catch(() => {
        // The synchronous interface cannot report it; closeTerminals() callers see the error.
      });
    },

    closeTerminals,

    async detach() {
      detached = true;
      for (const member of members()) member.stopRecovery();
      await starting?.catch(() => {});
      await Promise.all(members().map((member) => member.manager.detach()));
    },

    async adoptTerminals() {
      const counts = await Promise.all(members().map((member) => member.manager.adoptTerminals()));
      for (const member of Array.from(draining)) releaseIfDrained(member);
      return counts.reduce((sum, count) => sum + count, 0);
    },

    subscribeTerminalsChanged(listener) {
      terminalsChangedListeners.add(listener);
      return () => terminalsChangedListeners.delete(listener);
    },

    subscribeTerminalActivity(listener) {
      terminalActivityListeners.add(listener);
      return () => terminalActivityListeners.delete(listener);
    },

    subscribeTerminalWorkspaceContributionChanged(listener) {
      contributionListeners.add(listener);
      return () => contributionListeners.delete(listener);
    },
  };
}

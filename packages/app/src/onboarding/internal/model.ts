export type OnboardingStepId = "appearance" | "providers" | "projects" | "orchestration" | "phone";

const STEPS_WITHOUT_PHONE: readonly OnboardingStepId[] = [
  "appearance",
  "providers",
  "projects",
  "orchestration",
];
const STEPS_WITH_PHONE: readonly OnboardingStepId[] = [...STEPS_WITHOUT_PHONE, "phone"];

export interface OnboardingCompletionStorage {
  isCompleted(): Promise<boolean>;
  markCompleted(): Promise<void>;
}

/** The host setup runs against: the desktop's managed daemon, otherwise the first saved host. */
export interface OnboardingSetupHost {
  serverId: string;
  isConnected: boolean;
  hasHydratedWorkspaces: boolean;
  hasProjects: boolean;
}

export interface OnboardingStepOptions {
  /** False when the client is itself a phone, where pairing a phone makes no sense. */
  includePhoneStep: boolean;
}

export type OnboardingState =
  | { status: "deciding" }
  | { status: "hidden" }
  | {
      status: "open";
      serverId: string;
      steps: readonly OnboardingStepId[];
      stepIndex: number;
    };

export interface OnboardingModel {
  /** Resolves once the completion record has loaded. */
  ready: Promise<void>;
  getState(): OnboardingState;
  subscribe(listener: () => void): () => void;
  applySetupHost(host: OnboardingSetupHost | null, options: OnboardingStepOptions): void;
  reopen(serverId: string, options: OnboardingStepOptions): void;
  /** Leaves `from` for the following step. A no-op once the user is on another step or closed setup. */
  next(from: OnboardingStepId): void;
  back(): void;
  goTo(step: OnboardingStepId): void;
  /** Closes setup, whether the user finished or skipped it, and remembers that on this client. */
  complete(): Promise<void>;
}

type Completion = "loading" | "completed" | "pending";

interface PendingHost {
  host: OnboardingSetupHost | null;
  options: OnboardingStepOptions;
}

function isReadyForSetup(host: OnboardingSetupHost | null): host is OnboardingSetupHost {
  return host !== null && host.isConnected && host.hasHydratedWorkspaces;
}

function openState(serverId: string, options: OnboardingStepOptions): OnboardingState {
  return {
    status: "open",
    serverId,
    steps: options.includePhoneStep ? STEPS_WITH_PHONE : STEPS_WITHOUT_PHONE,
    stepIndex: 0,
  };
}

export function createOnboardingModel(input: {
  storage: OnboardingCompletionStorage;
}): OnboardingModel {
  const listeners = new Set<() => void>();
  let state: OnboardingState = { status: "deciding" };
  let completion: Completion = "loading";
  let pendingHost: PendingHost | null = null;

  function setState(next: OnboardingState) {
    state = next;
    for (const listener of listeners) {
      listener();
    }
  }

  // The gate is decided once per launch: a host that later loses its projects, or a
  // project added during setup, never flips the decision.
  function decide() {
    if (state.status !== "deciding" || completion === "loading") return;
    if (completion === "completed") {
      setState({ status: "hidden" });
      return;
    }
    const host = pendingHost?.host ?? null;
    if (!pendingHost || !isReadyForSetup(host)) return;
    setState(
      host.hasProjects ? { status: "hidden" } : openState(host.serverId, pendingHost.options),
    );
  }

  function moveTo(stepIndex: number) {
    if (state.status !== "open") return;
    const clamped = Math.max(0, Math.min(stepIndex, state.steps.length - 1));
    if (clamped === state.stepIndex) return;
    setState({ ...state, stepIndex: clamped });
  }

  async function loadCompletion(): Promise<void> {
    try {
      completion = (await input.storage.isCompleted()) ? "completed" : "pending";
    } catch {
      // An unreadable record must not trap an existing user in setup.
      completion = "completed";
    }
    decide();
  }

  const ready = loadCompletion();

  return {
    ready,
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    applySetupHost(host, options) {
      pendingHost = { host, options };
      decide();
    },
    reopen(serverId, options) {
      setState(openState(serverId, options));
    },
    next(from) {
      if (state.status === "open" && state.steps[state.stepIndex] === from) {
        moveTo(state.stepIndex + 1);
      }
    },
    back() {
      if (state.status === "open") moveTo(state.stepIndex - 1);
    },
    goTo(step) {
      if (state.status !== "open") return;
      const stepIndex = state.steps.indexOf(step);
      if (stepIndex >= 0) moveTo(stepIndex);
    },
    async complete() {
      completion = "completed";
      setState({ status: "hidden" });
      await input.storage.markCompleted();
    },
  };
}

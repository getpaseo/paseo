import type { PluginSubmissionChoice, PluginSubmissionDecision } from "@getpaseo/plugin/client";

export class SubmissionCancelledError extends Error {
  constructor() {
    super("Submission cancelled");
    this.name = "SubmissionCancelledError";
  }
}

export function openSubmissionDecision(decision: PluginSubmissionDecision, signal: AbortSignal) {
  if (
    !decision.title.trim() ||
    decision.choices.length === 0 ||
    decision.choices.some((choice) => !choice.id.trim() || !choice.title.trim()) ||
    new Set(decision.choices.map((choice) => choice.id)).size !== decision.choices.length ||
    (decision.timeout &&
      (!Number.isFinite(decision.timeout.seconds) ||
        decision.timeout.seconds <= 0 ||
        !decision.choices.some((choice) => choice.id === decision.timeout?.choiceId)))
  )
    throw new Error("Plugin returned an invalid submission decision");
  const listeners = new Set<() => void>();
  let state = {
    textValue: decision.textInput?.initialValue ?? "",
    secondsRemaining: decision.timeout ? Math.ceil(decision.timeout.seconds) : null,
    timerActive: Boolean(decision.timeout),
    closed: false,
  };
  let finish!: (choice: PluginSubmissionChoice | null) => void;
  const result = new Promise<PluginSubmissionChoice | null>((resolve) => {
    finish = resolve;
  });
  let timer: ReturnType<typeof setInterval> | undefined;
  const publish = (patch: Partial<typeof state>) => {
    state = { ...state, ...patch };
    for (const listener of listeners) listener();
  };
  const close = (choice: PluginSubmissionChoice | null) => {
    if (state.closed) return;
    clearInterval(timer);
    signal.removeEventListener("abort", cancel);
    publish({ closed: true, timerActive: false });
    finish(choice);
  };
  const cancel = () => close(null);
  const choose = (choiceId: string, automatic = false) => {
    if (!decision.choices.some((choice) => choice.id === choiceId))
      throw new Error("Unknown submission choice");
    close({
      choiceId,
      automatic,
      ...(decision.textInput ? { textValue: state.textValue } : {}),
    });
  };
  const interact = () => {
    if (state.closed || !state.timerActive) return;
    clearInterval(timer);
    publish({ timerActive: false });
  };
  signal.addEventListener("abort", cancel, { once: true });
  if (signal.aborted) cancel();
  else if (decision.timeout) {
    const { seconds, choiceId } = decision.timeout;
    const deadline = Date.now() + seconds * 1000;
    timer = setInterval(() => {
      const secondsRemaining = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
      publish({ secondsRemaining });
      if (secondsRemaining === 0) choose(choiceId, true);
    }, 1000);
  }
  return {
    decision,
    result,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getState: () => state,
    choose,
    interact,
    setText(value: string) {
      if (state.closed) return;
      interact();
      publish({ textValue: value });
    },
    cancel,
  };
}

export type SubmissionDecisionModel = ReturnType<typeof openSubmissionDecision>;

let current: SubmissionDecisionModel | null = null;
let queue = Promise.resolve();
let generation = 0;
const listeners = new Set<() => void>();
const publish = () => {
  for (const listener of listeners) listener();
};

export const submissionDecisionStore = {
  getSnapshot: () => current,
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  cancel() {
    generation++;
    current?.cancel();
  },
};

export function presentSubmissionDecision(decision: PluginSubmissionDecision, signal: AbortSignal) {
  const requestedGeneration = generation;
  const pending = queue.then(async () => {
    if (signal.aborted || requestedGeneration !== generation) throw new SubmissionCancelledError();
    const model = openSubmissionDecision(decision, signal);
    current = model;
    publish();
    try {
      const choice = await model.result;
      if (!choice) throw new SubmissionCancelledError();
      return choice;
    } finally {
      if (current === model) current = null;
      model.cancel();
      publish();
    }
  });
  queue = pending.then(
    () => undefined,
    () => undefined,
  );
  return pending;
}

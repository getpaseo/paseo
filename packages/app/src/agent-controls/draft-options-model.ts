import type {
  AgentOptionControl,
  AgentSessionConfig,
  ProviderOptions,
} from "@getpaseo/protocol/agent-types";
import { withoutLostControls } from "./lost-controls";

/**
 * The options of one draft agent, as a plain model (see docs/forms.md). It owns which layers
 * make up the draft's options; the daemon owns what they mean. Every layer is sent to the daemon
 * (`ownDraftOptions`) and the UI draws what comes back (`viewDraftOptions`), so no alias,
 * default or legacy key is resolved here.
 *
 * - `seed`: options the draft started from (a profile, a forked agent).
 * - `remembered`: the provider's last-used control values.
 * - `edits`: toggles made in this draft.
 *
 * Choosing a provider by hand starts the options over; applying a profile replaces the provider
 * and the options in one step, so the provider change that follows does not clear them.
 */
export interface ResolvedDraftOptions {
  provider: string;
  /** Names the request that produced this answer; see `viewDraftOptions`. */
  requestKey: string;
  controls: AgentOptionControl[];
  options: ProviderOptions;
}

export interface DraftOptionsState {
  provider: string | null;
  seed: ProviderOptions;
  remembered: ProviderOptions;
  edits: ProviderOptions;
  resolved: ResolvedDraftOptions | null;
  /** Every key an answer for this provider has drawn as a control. */
  drawn: ReadonlySet<string>;
}

export interface DraftOptionsModel {
  getState: () => DraftOptionsState;
  subscribe: (listener: () => void) => () => void;
  /** The provider the draft's form now has. A different one than the model's is a manual choice. */
  observeProvider: (provider: string | null) => void;
  applyProfile: (profile: { provider: string; options: ProviderOptions }) => void;
  setRemembered: (remembered: ProviderOptions) => void;
  setOption: (key: string, value: unknown) => void;
  applyResolved: (resolved: ResolvedDraftOptions) => void;
}

export function openDraftOptions(input: {
  provider: string | null;
  seed?: ProviderOptions;
}): DraftOptionsModel {
  let state: DraftOptionsState = {
    provider: input.provider,
    seed: input.seed ?? {},
    remembered: {},
    edits: {},
    resolved: null,
    drawn: new Set(),
  };
  const listeners = new Set<() => void>();

  function publish(update: (current: DraftOptionsState) => DraftOptionsState): void {
    const next = update(state);
    if (next === state) return;
    state = next;
    for (const listener of listeners) listener();
  }

  return {
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    observeProvider: (provider) =>
      publish((current) => {
        if (provider === current.provider) return current;
        // The first provider a draft picks does not discard what it was opened with.
        if (current.provider === null) return { ...current, provider };
        return {
          ...current,
          provider,
          seed: {},
          edits: {},
          resolved: null,
          drawn: new Set(),
        };
      }),
    applyProfile: (profile) =>
      publish((current) => ({
        ...current,
        provider: profile.provider,
        seed: profile.options,
        edits: {},
        resolved: current.provider === profile.provider ? current.resolved : null,
        drawn: current.provider === profile.provider ? current.drawn : new Set(),
      })),
    setRemembered: (remembered) => publish((current) => ({ ...current, remembered })),
    setOption: (key, value) =>
      publish((current) =>
        Object.is(current.edits[key], value)
          ? current
          : { ...current, edits: { ...current.edits, [key]: value } },
      ),
    applyResolved: (resolved) =>
      publish((current) => ({
        ...current,
        resolved,
        drawn: new Set([...current.drawn, ...resolved.controls.map((control) => control.key)]),
      })),
  };
}

/**
 * Everything the draft would create with, for the daemon to resolve. A last-used value applies
 * once the provider has told us it still draws a control for that key, and never over the seed.
 * An edit of a key an earlier answer drew as a control stops applying when the latest answer
 * draws none for it (the model changed to one without that control) and applies again when a
 * control for it returns. An edit of a key no answer has drawn is an option without a control
 * and always applies.
 */
export function ownDraftOptions(state: DraftOptionsState): ProviderOptions | undefined {
  const controlKeys = new Set((state.resolved?.controls ?? []).map((control) => control.key));
  const remembered = Object.fromEntries(
    Object.entries(state.remembered).filter(
      ([key]) => controlKeys.has(key) && !(key in state.seed),
    ),
  );
  const edits = withoutLostControls(state.edits, state.drawn, controlKeys);
  const own = { ...state.seed, ...remembered, ...edits };
  return Object.keys(own).length > 0 ? own : undefined;
}

export type DraftControlsRequest = Pick<
  AgentSessionConfig,
  "provider" | "cwd" | "modeId" | "model" | "thinkingOptionId" | "providerOptions"
>;

/** What the draft's form has chosen; the options come from the model. */
export interface DraftControlsForm {
  provider: string | null;
  cwd: string;
  modeId?: string | null;
  modelId?: string | null;
  thinkingOptionId?: string | null;
}

/**
 * The listing request for the draft's form, built from one snapshot of the model. The form
 * reaches a new provider before the model has observed it, and the model still holds the
 * previous provider's options until it does; that render has no request, so a request never
 * pairs one provider with another's options.
 */
export function draftControlsRequest(
  state: DraftOptionsState,
  form: DraftControlsForm,
): DraftControlsRequest | null {
  if (!form.provider || !form.cwd || form.provider !== state.provider) return null;
  const providerOptions = ownDraftOptions(state);
  return {
    provider: form.provider,
    cwd: form.cwd,
    ...(form.modeId ? { modeId: form.modeId } : {}),
    ...(form.modelId ? { model: form.modelId } : {}),
    ...(form.thinkingOptionId ? { thinkingOptionId: form.thinkingOptionId } : {}),
    ...(providerOptions ? { providerOptions } : {}),
  };
}

/**
 * What the controls draw: the daemon's answer for this provider. The last answer stays up while
 * a newer request is in flight, with the toggles made since laid over it, so a switch does not
 * wait for the round trip. It never carries a seed or remembered value the daemon has not
 * resolved.
 */
export function viewDraftOptions(
  state: DraftOptionsState,
  current: { provider: string | null; requestKey: string },
): { controls: AgentOptionControl[]; options: ProviderOptions } | undefined {
  const { resolved } = state;
  if (!resolved || resolved.provider !== current.provider) return undefined;
  return {
    controls: resolved.controls,
    options:
      resolved.requestKey === current.requestKey
        ? resolved.options
        : { ...resolved.options, ...state.edits },
  };
}

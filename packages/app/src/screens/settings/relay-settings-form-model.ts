import { normalizeRelayEndpoint } from "@getpaseo/protocol/daemon-endpoints";
import type { MutableDaemonConfigPatch } from "@getpaseo/protocol/messages";
import {
  RELAY_CONFIG_FIELDS,
  RELAY_CONFIG_FIELD_KEYS,
  type RelayConfigField,
} from "@getpaseo/protocol/relay-config";

export interface RelaySettingsValues {
  enabled: boolean;
  endpoint: string;
  publicEndpoint: string;
  useTls: boolean;
  publicUseTls: boolean;
}

export type RelaySettingsField = RelayConfigField;
export type RelaySettingsError = "hostPort";

interface RelaySettingsFormStateBase {
  values: RelaySettingsValues;
  errors: Partial<Record<RelaySettingsField, RelaySettingsError>>;
  isDirty: boolean;
  canSubmit: boolean;
}

export type RelaySettingsFormState =
  | (RelaySettingsFormStateBase & {
      phase: "editing";
      error: { kind: "save" | "relayDisable"; message: string } | null;
    })
  | (RelaySettingsFormStateBase & { phase: "saving"; error: null })
  | (RelaySettingsFormStateBase & {
      phase: "restartRequired";
      error: { kind: "migration" | "restart"; message: string } | null;
    })
  | (RelaySettingsFormStateBase & { phase: "migrating"; error: null })
  | (RelaySettingsFormStateBase & { phase: "restarting"; error: null });

type RelaySettingsTransitionState<State = RelaySettingsFormState> =
  State extends RelaySettingsFormState ? Pick<State, "phase" | "error"> : never;

export interface RelaySettingsFormModel {
  getState(): RelaySettingsFormState;
  subscribe(listener: () => void): () => void;
  setField<Field extends RelaySettingsField>(field: Field, value: RelaySettingsValues[Field]): void;
  buildPatch(): MutableDaemonConfigPatch | null;
  hasRestartRequiredChanges(): boolean;
  getOverrideEnv(field: RelaySettingsField): string | null;
  startSaving(): void;
  markSaveFailed(message: string): void;
  markRelayDisableBlocked(message: string): void;
  markRestartRequired(savedValues?: RelaySettingsValues): void;
  startMigrating(): void;
  markMigrationFailed(message: string): void;
  startRestarting(): void;
  markRestartFailed(message: string): void;
  close(): void;
}

function normalizeEndpoint(value: string): string | null {
  if (value.includes("://")) return null;
  try {
    return normalizeRelayEndpoint(value);
  } catch {
    return null;
  }
}

export function createRelaySettingsFormModel(input: {
  initialValues: RelaySettingsValues;
  overrideControlledPaths: readonly string[];
}): RelaySettingsFormModel {
  const initialValues = { ...input.initialValues };
  const overrideControlledPaths = new Set(input.overrideControlledPaths);
  const listeners = new Set<() => void>();
  let values = { ...initialValues };
  let transitionState: RelaySettingsTransitionState = {
    phase: "editing",
    error: null,
  };
  let closed = false;
  let state = buildState();

  function isOverridden(field: RelaySettingsField): boolean {
    return overrideControlledPaths.has(RELAY_CONFIG_FIELDS[field].persistedPath);
  }

  function normalizedValue(
    field: RelaySettingsField,
  ): RelaySettingsValues[RelaySettingsField] | null {
    const value = values[field];
    if (field === "endpoint" || field === "publicEndpoint") {
      return normalizeEndpoint(value as string);
    }
    return value;
  }

  function changedFields(): RelaySettingsField[] {
    return RELAY_CONFIG_FIELD_KEYS.filter((field) => {
      if (isOverridden(field)) return false;
      const normalized = normalizedValue(field);
      return normalized !== null && normalized !== initialValues[field];
    });
  }

  function buildState(): RelaySettingsFormState {
    const errors: Partial<Record<RelaySettingsField, RelaySettingsError>> = {};
    for (const field of ["endpoint", "publicEndpoint"] as const) {
      if (!isOverridden(field) && normalizeEndpoint(values[field]) === null) {
        errors[field] = "hostPort";
      }
    }
    const isDirty = changedFields().length > 0;
    const common = {
      values: { ...values },
      errors,
      isDirty,
      canSubmit: isDirty && Object.keys(errors).length === 0,
    };
    return { ...common, ...transitionState };
  }

  function publish(): void {
    if (closed) return;
    state = buildState();
    for (const listener of listeners) listener();
  }

  function transition(next: RelaySettingsTransitionState): void {
    transitionState = next;
    publish();
  }

  function setField<Field extends RelaySettingsField>(
    field: Field,
    value: RelaySettingsValues[Field],
  ): void {
    if (closed || transitionState.phase !== "editing" || values[field] === value) return;
    values = { ...values, [field]: value };
    transitionState = { phase: "editing", error: null };
    publish();
  }

  function buildPatch(): MutableDaemonConfigPatch | null {
    if (!state.canSubmit) return null;
    const relay: NonNullable<MutableDaemonConfigPatch["relay"]> = {};
    for (const field of changedFields()) {
      const value = normalizedValue(field);
      if (value === null) return null;
      Object.assign(relay, { [field]: value });
    }
    return { relay };
  }

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setField,
    buildPatch,
    hasRestartRequiredChanges: () =>
      changedFields().some((field) => RELAY_CONFIG_FIELDS[field].restartRequired),
    getOverrideEnv: (field) => (isOverridden(field) ? RELAY_CONFIG_FIELDS[field].env : null),
    startSaving: () => {
      if (transitionState.phase === "editing") transition({ phase: "saving", error: null });
    },
    markSaveFailed: (message) => {
      if (transitionState.phase === "saving") {
        transition({ phase: "editing", error: { kind: "save", message } });
      }
    },
    markRelayDisableBlocked: (message) => {
      if (transitionState.phase === "editing") {
        transition({ phase: "editing", error: { kind: "relayDisable", message } });
      }
    },
    markRestartRequired: (savedValues) => {
      if (transitionState.phase !== "saving") return;
      if (savedValues) values = { ...savedValues };
      transition({ phase: "restartRequired", error: null });
    },
    startMigrating: () => {
      if (transitionState.phase === "restartRequired") {
        transition({ phase: "migrating", error: null });
      }
    },
    markMigrationFailed: (message) => {
      if (transitionState.phase === "migrating") {
        transition({ phase: "restartRequired", error: { kind: "migration", message } });
      }
    },
    startRestarting: () => {
      if (transitionState.phase === "migrating") {
        transition({ phase: "restarting", error: null });
      }
    },
    markRestartFailed: (message) => {
      if (transitionState.phase === "restarting") {
        transition({ phase: "restartRequired", error: { kind: "restart", message } });
      }
    },
    close() {
      closed = true;
      listeners.clear();
    },
  };
}

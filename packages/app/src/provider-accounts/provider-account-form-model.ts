import type { MutableDaemonConfigPatch } from "@getpaseo/protocol/messages";

/** Provider ids the daemon reserves; a new account can never claim one. */
export const RESERVED_PROVIDER_IDS = [
  "claude",
  "codex",
  "copilot",
  "opencode",
  "pi",
  "omp",
  "acp",
] as const;

/**
 * Builtin providers an account can extend. `acp` is excluded: ACP entries are
 * installed from the catalog with their own command, not cloned per account.
 */
export const ACCOUNT_BASE_PROVIDER_IDS = [
  "claude",
  "codex",
  "copilot",
  "opencode",
  "pi",
  "omp",
] as const;

// Mirrors ProviderOverridesSchema in packages/protocol/src/provider-config.ts.
export const PROVIDER_ID_PATTERN = /^[a-z][a-z0-9-]*$/;

export function canAddProviderAccount(input: {
  providerId: string;
  source: "builtin" | "custom" | undefined;
}): boolean {
  // `source` is optional on the wire, so daemons that predate it report
  // undefined. Reject only an explicit "custom": the daemon reports a builtin
  // id as "builtin" regardless of overrides, so no custom row can reach here.
  if (input.source === "custom") return false;
  return (ACCOUNT_BASE_PROVIDER_IDS as readonly string[]).includes(input.providerId);
}

export function deriveProviderAccountId(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^[^a-z]+/, "")
    .replace(/-+$/, "");
}

export type ProviderAccountLabelError = "required";
export type ProviderAccountIdError = "required" | "invalid" | "taken";
export type ProviderAccountEnvError = "keyRequired" | "duplicate";

export interface ProviderAccountEnvRow {
  id: string;
  key: string;
  value: string;
}

export interface ProviderAccountFormState {
  baseProviderId: string;
  baseProviderLabel: string;
  label: string;
  providerId: string;
  /** False while the id still tracks the label; the id input remounts on change. */
  providerIdEdited: boolean;
  description: string;
  envRows: ProviderAccountEnvRow[];
  /** Errors are only populated once the user can act on them. */
  labelError: ProviderAccountLabelError | null;
  providerIdError: ProviderAccountIdError | null;
  envErrors: Record<string, ProviderAccountEnvError>;
  canSubmit: boolean;
  isSubmitting: boolean;
}

export interface ProviderAccountFormSnapshot {
  baseProviderId: string;
  baseProviderLabel: string;
  existingProviderIds: readonly string[];
}

export interface ProviderAccountFormModel {
  getState: () => ProviderAccountFormState;
  subscribe: (listener: () => void) => () => void;
  close: () => void;
  applyExistingProviderIds: (providerIds: readonly string[]) => void;
  setLabel: (value: string) => void;
  setProviderId: (value: string) => void;
  setDescription: (value: string) => void;
  addEnvRow: () => void;
  removeEnvRow: (rowId: string) => void;
  setEnvKey: (rowId: string, value: string) => void;
  setEnvValue: (rowId: string, value: string) => void;
  setSubmitting: (value: boolean) => void;
  markSubmitAttempted: () => void;
  buildPatch: () => MutableDaemonConfigPatch | null;
}

interface InternalState {
  label: string;
  providerId: string;
  providerIdEdited: boolean;
  description: string;
  envRows: ProviderAccountEnvRow[];
  existingProviderIds: readonly string[];
  submitAttempted: boolean;
  isSubmitting: boolean;
}

interface Validation {
  labelError: ProviderAccountLabelError | null;
  providerIdError: ProviderAccountIdError | null;
  envErrors: Record<string, ProviderAccountEnvError>;
}

function validate(internal: InternalState): Validation {
  const labelError: ProviderAccountLabelError | null =
    internal.label.trim().length === 0 ? "required" : null;

  const providerId = internal.providerId.trim();
  const taken = new Set<string>([
    ...RESERVED_PROVIDER_IDS,
    ...internal.existingProviderIds.map((value) => value.trim()),
  ]);
  let providerIdError: ProviderAccountIdError | null = null;
  if (providerId.length === 0) {
    providerIdError = "required";
  } else if (!PROVIDER_ID_PATTERN.test(providerId)) {
    providerIdError = "invalid";
  } else if (taken.has(providerId)) {
    providerIdError = "taken";
  }

  const envErrors: Record<string, ProviderAccountEnvError> = {};
  const seenKeys = new Set<string>();
  for (const row of internal.envRows) {
    const key = row.key.trim();
    if (key.length === 0) {
      if (row.value.trim().length > 0) {
        envErrors[row.id] = "keyRequired";
      }
      continue;
    }
    if (seenKeys.has(key)) {
      envErrors[row.id] = "duplicate";
      continue;
    }
    seenKeys.add(key);
  }

  return { labelError, providerIdError, envErrors };
}

function project(internal: InternalState, snapshot: ProviderAccountFormSnapshot) {
  const validation = validate(internal);
  const isValid =
    validation.labelError === null &&
    validation.providerIdError === null &&
    Object.keys(validation.envErrors).length === 0;

  // "required" is noise until the user tries to submit; format and collision
  // errors are actionable the moment the id field has been touched.
  const showLabelError = internal.submitAttempted;
  const showProviderIdError =
    internal.submitAttempted ||
    (internal.providerIdEdited && validation.providerIdError !== "required");

  const state: ProviderAccountFormState = {
    baseProviderId: snapshot.baseProviderId,
    baseProviderLabel: snapshot.baseProviderLabel,
    label: internal.label,
    providerId: internal.providerId,
    providerIdEdited: internal.providerIdEdited,
    description: internal.description,
    envRows: internal.envRows,
    labelError: showLabelError ? validation.labelError : null,
    providerIdError: showProviderIdError ? validation.providerIdError : null,
    envErrors: validation.envErrors,
    canSubmit: isValid && !internal.isSubmitting,
    isSubmitting: internal.isSubmitting,
  };
  return state;
}

export function buildProviderAccountConfigPatch(input: {
  providerId: string;
  baseProviderId: string;
  label: string;
  description: string;
  envRows: readonly ProviderAccountEnvRow[];
}): MutableDaemonConfigPatch {
  const env: Record<string, string> = {};
  for (const row of input.envRows) {
    const key = row.key.trim();
    if (key.length === 0) continue;
    env[key] = row.value.trim();
  }
  const description = input.description.trim();

  return {
    providers: {
      [input.providerId.trim()]: {
        extends: input.baseProviderId,
        label: input.label.trim(),
        ...(description ? { description } : {}),
        env,
      },
    },
  };
}

export function openProviderAccountForm(
  snapshot: ProviderAccountFormSnapshot,
): ProviderAccountFormModel {
  let rowCounter = 0;
  const createRow = (): ProviderAccountEnvRow => {
    rowCounter += 1;
    return { id: `env-${rowCounter}`, key: "", value: "" };
  };

  let internal: InternalState = {
    label: "",
    providerId: "",
    providerIdEdited: false,
    description: "",
    envRows: [createRow()],
    existingProviderIds: [...snapshot.existingProviderIds],
    submitAttempted: false,
    isSubmitting: false,
  };

  let listeners = new Set<() => void>();
  let state = project(internal, snapshot);

  const publish = (next: InternalState) => {
    internal = next;
    state = project(internal, snapshot);
    for (const listener of listeners) listener();
  };

  const mapRows = (rowId: string, update: (row: ProviderAccountEnvRow) => ProviderAccountEnvRow) =>
    internal.envRows.map((row) => (row.id === rowId ? update(row) : row));

  return {
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    close: () => {
      listeners = new Set();
    },
    applyExistingProviderIds: (providerIds) => {
      const next = [...providerIds];
      const unchanged =
        next.length === internal.existingProviderIds.length &&
        next.every((value, index) => value === internal.existingProviderIds[index]);
      if (unchanged) return;
      publish({ ...internal, existingProviderIds: next });
    },
    setLabel: (value) => {
      publish({
        ...internal,
        label: value,
        providerId: internal.providerIdEdited
          ? internal.providerId
          : deriveProviderAccountId(value),
      });
    },
    setProviderId: (value) => {
      publish({ ...internal, providerId: value, providerIdEdited: true });
    },
    setDescription: (value) => {
      publish({ ...internal, description: value });
    },
    addEnvRow: () => {
      publish({ ...internal, envRows: [...internal.envRows, createRow()] });
    },
    removeEnvRow: (rowId) => {
      const remaining = internal.envRows.filter((row) => row.id !== rowId);
      publish({ ...internal, envRows: remaining.length > 0 ? remaining : [createRow()] });
    },
    setEnvKey: (rowId, value) => {
      publish({ ...internal, envRows: mapRows(rowId, (row) => ({ ...row, key: value })) });
    },
    setEnvValue: (rowId, value) => {
      publish({ ...internal, envRows: mapRows(rowId, (row) => ({ ...row, value })) });
    },
    setSubmitting: (value) => {
      publish({ ...internal, isSubmitting: value });
    },
    markSubmitAttempted: () => {
      publish({ ...internal, submitAttempted: true });
    },
    buildPatch: () => {
      if (!state.canSubmit) return null;
      return buildProviderAccountConfigPatch({
        providerId: internal.providerId,
        baseProviderId: snapshot.baseProviderId,
        label: internal.label,
        description: internal.description,
        envRows: internal.envRows,
      });
    },
  };
}

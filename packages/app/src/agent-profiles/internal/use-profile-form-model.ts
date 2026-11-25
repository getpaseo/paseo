import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { AgentProfile } from "@getpaseo/protocol/messages";
import { useProvidersSnapshot } from "@/hooks/use-providers-snapshot";
import { toErrorMessage } from "@/utils/error-messages";
import {
  openAgentProfileForm,
  type AgentProfileFormModel,
  type AgentProfileFormSnapshot,
  type AgentProfileFormState,
  type AgentProfileSeed,
  type AgentProfileValue,
} from "./profile-form-model";
import { useAgentProfileFormCatalog, useAgentProfileFormControls } from "./use-profile-form-inputs";

/**
 * One model per mount. The sheet or drawer host keys its session on mode + profile id,
 * so create and edit never share an instance and reopening always starts from the record.
 */
export function useAgentProfileFormModel(
  snapshot: AgentProfileFormSnapshot,
): AgentProfileFormModel {
  const [model] = useState(() => openAgentProfileForm(snapshot));

  useEffect(() => {
    return () => {
      model.close();
    };
  }, [model]);

  return model;
}

export function useAgentProfileFormState(model: AgentProfileFormModel): AgentProfileFormState {
  return useSyncExternalStore(model.subscribe, model.getState, model.getState);
}

export interface AgentProfileFormSession {
  model: AgentProfileFormModel;
  state: AgentProfileFormState;
  isDirty: boolean;
  save: () => Promise<boolean>;
}

function stableRecordKey(record: Record<string, unknown> | undefined): string {
  if (!record) {
    return "";
  }
  const keys = Object.keys(record).sort();
  if (keys.length === 0) {
    return "";
  }
  return JSON.stringify(keys.map((key) => [key, record[key]]));
}

function draftFingerprint(input: {
  name: string;
  icon?: string;
  color?: string;
  provider: string;
  modelId?: string;
  modeId?: string;
  thinkingOptionId?: string;
  notes?: string;
  options?: Record<string, unknown>;
}): string {
  return JSON.stringify([
    input.name.trim(),
    input.icon ?? "",
    input.color ?? "",
    input.provider,
    input.modelId ?? "",
    input.modeId ?? "",
    input.thinkingOptionId ?? "",
    (input.notes ?? "").trim(),
    stableRecordKey(input.options),
  ]);
}

function computeIsDirty(
  mode: "create" | "edit",
  state: AgentProfileFormState,
  profile: AgentProfile | undefined,
  seed: AgentProfileSeed | undefined,
): boolean {
  const current = draftFingerprint({
    name: state.name,
    icon: state.icon,
    color: state.color,
    provider: state.provider,
    modelId: state.modelId,
    modeId: state.modeId,
    thinkingOptionId: state.thinkingOptionId,
    notes: state.notes,
    options: state.controlOptions,
  });
  if (mode === "edit" && profile) {
    return (
      current !==
      draftFingerprint({
        name: profile.name,
        icon: profile.icon,
        color: profile.color,
        provider: profile.provider,
        modelId: profile.model,
        modeId: profile.modeId,
        thinkingOptionId: profile.thinkingOptionId,
        notes: profile.notes,
        options: profile.options,
      })
    );
  }
  return (
    current !==
    draftFingerprint({
      name: seed?.name ?? "",
      provider: seed?.provider ?? "",
      modelId: seed?.modelId ?? "",
      modeId: state.modeId,
      thinkingOptionId: state.thinkingOptionId,
    })
  );
}

/**
 * Shared form session used by both the desktop inspector drawer and the modal sheet.
 * Lifting this above drawer/modal framing lets responsive switches preserve unsaved edits.
 */
export function useAgentProfileFormSession({
  serverId,
  mode,
  profile,
  seed,
  onSave,
  onSaved,
}: {
  serverId: string;
  mode: "create" | "edit";
  profile?: AgentProfile;
  seed?: AgentProfileSeed;
  onSave: (value: AgentProfileValue) => Promise<void>;
  onSaved: () => void;
}): AgentProfileFormSession {
  const { entries } = useProvidersSnapshot(serverId, { cwd: null });
  const snapshot = useMemo<AgentProfileFormSnapshot>(
    () => ({
      mode,
      ...(profile ? { profile } : {}),
      ...(seed ? { seed } : {}),
      ...(entries ? { entries } : {}),
    }),
    [entries, mode, profile, seed],
  );
  const model = useAgentProfileFormModel(snapshot);
  const state = useAgentProfileFormState(model);
  useAgentProfileFormCatalog({ serverId, model });
  useAgentProfileFormControls({ serverId, model, state });

  const isDirty = useMemo(
    () => computeIsDirty(mode, state, profile, seed),
    [mode, profile, seed, state],
  );

  const save = useCallback(async (): Promise<boolean> => {
    const value = model.getState().submitValue;
    if (!value) {
      return false;
    }
    model.setSubmitError(null);
    model.setSubmitting(true);
    try {
      await onSave(value);
      onSaved();
      return true;
    } catch (error) {
      model.setSubmitError(toErrorMessage(error));
      return false;
    } finally {
      model.setSubmitting(false);
    }
  }, [model, onSave, onSaved]);

  return useMemo(() => ({ model, state, isDirty, save }), [isDirty, model, save, state]);
}

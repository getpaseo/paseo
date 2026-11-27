import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
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
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const save = useCallback(async (): Promise<boolean> => {
    const value = model.getState().submitValue;
    if (!value) {
      return false;
    }
    model.setSubmitError(null);
    model.setSubmitting(true);
    try {
      await onSave(value);
      // Only notify completion while this session is still active; switching profiles
      // mid-save unmounts this session and must not close the next editor's draft.
      if (mountedRef.current) {
        onSaved();
      }
      return true;
    } catch (error) {
      model.setSubmitError(toErrorMessage(error));
      return false;
    } finally {
      model.setSubmitting(false);
    }
  }, [model, onSave, onSaved]);

  return useMemo(() => ({ model, state, isDirty: state.isDirty, save }), [model, save, state]);
}

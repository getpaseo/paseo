import { useEffect, useState, useSyncExternalStore } from "react";
import {
  openAgentProfileForm,
  type AgentProfileFormModel,
  type AgentProfileFormSnapshot,
  type AgentProfileFormState,
} from "./profile-form-model";

/**
 * One model per mount. The modal keys its body on mode + profile id, so create
 * and edit never share an instance and reopening always starts from the record.
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

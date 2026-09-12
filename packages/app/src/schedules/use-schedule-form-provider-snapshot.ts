import { useEffect } from "react";
import { useProvidersSnapshot } from "@/hooks/use-providers-snapshot";
import { useModelVisibility } from "@/hooks/use-model-visibility";
import type { ScheduleFormModel, ScheduleFormState } from "./schedule-form-model";

export function useScheduleFormProviderSnapshot(
  model: ScheduleFormModel,
  state: ScheduleFormState,
) {
  const serverId = state.providerSnapshotRequest?.serverId ?? state.selectedServerId;
  const cwd = state.providerSnapshotRequest?.cwd ?? state.workingDir;
  const enabled = state.targetKind === "new-agent" && Boolean(serverId && cwd.trim());
  const snapshot = useProvidersSnapshot(serverId ?? null, {
    cwd,
    enabled,
  });

  const modelVisibility = useModelVisibility(serverId ?? null);

  useEffect(() => {
    model.applyModelVisibility(modelVisibility);
  }, [model, modelVisibility]);

  useEffect(() => {
    if (!enabled || !serverId || !snapshot.entries) {
      return;
    }
    model.applyProviderSnapshot(serverId, { entries: snapshot.entries });
  }, [enabled, model, serverId, snapshot.entries]);

  // The sheet's Retry needs the visibility side too, so it is returned rather
  // than being consumed and dropped here.
  return {
    ...snapshot,
    modelVisibilityStatus: modelVisibility.status,
    retryModelVisibility: modelVisibility.retry,
  };
}

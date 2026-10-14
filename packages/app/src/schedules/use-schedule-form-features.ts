import { useEffect } from "react";
import { useFetchQuery } from "@/data/query";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import type { ScheduleFormModel, ScheduleFormState } from "./schedule-form-model";

export function useScheduleFormFeatures(model: ScheduleFormModel, state: ScheduleFormState) {
  const serverId = state.selectedServerId;
  const provider = state.selectedProvider;
  const cwd = state.workingDir;
  const modelId = state.selectedModel;
  const client = useHostRuntimeClient(serverId ?? "");
  const isConnected = useHostRuntimeIsConnected(serverId ?? "");
  const featuresQuery = useFetchQuery({
    queryKey: ["scheduleProviderFeatures", serverId, provider, cwd, modelId],
    enabled: state.targetKind === "new-agent" && Boolean(client && isConnected && provider && cwd),
    dataShape: "value",
    staleTimeMs: 5 * 60 * 1000,
    queryFn: async () => {
      if (!client || !provider) {
        throw new Error("Host disconnected");
      }
      const payload = await client.listProviderFeatures({
        provider,
        cwd,
        model: modelId || undefined,
      });
      if (payload.error) {
        throw new Error(payload.error);
      }
      return payload.features ?? [];
    },
  });

  useEffect(() => {
    if (!serverId || !provider || !featuresQuery.data) {
      return;
    }
    model.applyFeatureSnapshot({ serverId, provider, cwd, modelId, features: featuresQuery.data });
  }, [model, serverId, provider, cwd, modelId, featuresQuery.data]);
}

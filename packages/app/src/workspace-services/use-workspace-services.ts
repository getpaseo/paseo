import { useCallback, useEffect, useState } from "react";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { WorkspaceServicePayload } from "@getpaseo/protocol/messages";

export function useWorkspaceServices(input: { client: DaemonClient | null; workspaceId: string }): {
  services: WorkspaceServicePayload[];
  error: string | null;
  refresh: () => Promise<void>;
} {
  const [services, setServices] = useState<WorkspaceServicePayload[]>([]);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!input.client || typeof input.client.listWorkspaceServices !== "function") return;
    const result = await input.client.listWorkspaceServices(input.workspaceId);
    if (result.error) {
      setError(result.error);
      return;
    }
    setError(null);
    setServices(result.services);
  }, [input.client, input.workspaceId]);

  useEffect(() => {
    if (!input.client || typeof input.client.listWorkspaceServices !== "function") return undefined;
    setServices((current) => (current.length === 0 ? current : []));
    setError((current) => (current === null ? current : null));
    let active = true;
    void refresh().catch((cause) => {
      if (active) setError(cause instanceof Error ? cause.message : "Failed to load services");
    });
    const unsubscribe = input.client.on("workspace.service.update", (message) => {
      if (!active || message.payload.workspaceId !== input.workspaceId) return;
      setError(null);
      setServices(message.payload.services);
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [input.client, input.workspaceId, refresh]);

  return { services, error, refresh };
}

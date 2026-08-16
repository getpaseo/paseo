import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { LiveFileModel, type LiveFileSession } from "./model";

export function useLiveFile(input: {
  client: DaemonClient | null;
  workspaceId: string;
  cwd: string | null;
  path: string | null;
  enabled: boolean;
  liveUpdates: boolean;
}) {
  const [model] = useState(() => new LiveFileModel());
  const session = useMemo<LiveFileSession | null>(() => {
    if (!input.client) return null;
    const client = input.client;
    return {
      subscribe(target, onVersion) {
        return client.subscribeFile({ ...target, workspaceId: input.workspaceId }, onVersion);
      },
      read(target) {
        return client.readFile(target.cwd, target.path, undefined, input.workspaceId);
      },
    };
  }, [input.client, input.workspaceId]);

  useEffect(() => {
    if (!input.enabled || !session || !input.cwd || !input.path) {
      model.close();
      return;
    }
    model.open({
      session,
      target: { cwd: input.cwd, path: input.path },
      liveUpdates: input.liveUpdates,
    });
    return () => model.close();
  }, [input.cwd, input.enabled, input.liveUpdates, input.path, model, session]);

  const snapshot = useSyncExternalStore(model.subscribe, model.getSnapshot, model.getSnapshot);
  return {
    file: snapshot.observation?.status === "ready" ? snapshot.observation.file : null,
    error: snapshot.read.status === "error" ? snapshot.read.error : null,
    isFetching: snapshot.read.status === "pending",
    isRetrying: snapshot.read.status === "pending" && snapshot.read.requested,
    refresh: model.refresh,
    model,
  };
}

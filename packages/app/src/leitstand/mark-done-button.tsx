import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { useHostFeature } from "@/runtime/host-features";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";

export interface WorkspaceDoneToggle {
  done: boolean;
  pending: boolean;
  toggle: () => void;
}

/**
 * The one way a session becomes done: the person says so. The daemon stores the mark, so every
 * device agrees; hosts too old to store it get null rather than a mark that vanishes.
 */
export function useWorkspaceDoneToggle(
  serverId: string | null | undefined,
  workspaceId: string | null | undefined,
  /** Overrides the stored mark, for callers that already hold the session's state. */
  doneOverride?: boolean,
): WorkspaceDoneToggle | null {
  const client = useHostRuntimeClient(serverId ?? "");
  const isSupported = useHostFeature(serverId, "workspaceDone");
  const storedDone = useSessionStore((state) =>
    Boolean(state.sessions[serverId ?? ""]?.workspaces.get(workspaceId ?? "")?.doneAt),
  );
  const done = doneOverride ?? storedDone;
  const [pending, setPending] = useState(false);
  const toggle = useCallback(() => {
    if (!client || !workspaceId) return;
    setPending(true);
    client
      .setWorkspaceDone(workspaceId, !done)
      .catch(console.error)
      .finally(() => setPending(false));
  }, [client, done, workspaceId]);

  if (!isSupported || !client || !serverId || !workspaceId) return null;
  return { done, pending, toggle };
}

export function MarkDoneButton({
  serverId,
  workspaceId,
  done,
  size,
  testID,
}: {
  serverId: string;
  workspaceId: string;
  /** True offers to reopen a session marked done; omitted reads the stored mark. */
  done?: boolean;
  size: "xs" | "sm" | "md";
  testID: string;
}) {
  const { t } = useTranslation();
  const toggle = useWorkspaceDoneToggle(serverId, workspaceId, done);
  if (!toggle) return null;
  return (
    <Button
      variant="ghost"
      size={size}
      onPress={toggle.toggle}
      loading={toggle.pending}
      disabled={toggle.pending}
      testID={`${testID}-${toggle.done ? "reopen" : "done"}`}
    >
      {toggle.done ? t("leitstand.board.reopen") : t("leitstand.board.markDone")}
    </Button>
  );
}

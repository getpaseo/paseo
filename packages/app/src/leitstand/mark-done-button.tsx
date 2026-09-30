import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { useHostFeature } from "@/runtime/host-features";
import { useHostRuntimeClient } from "@/runtime/host-runtime";

/**
 * The one way a session becomes done: the person says so. The daemon stores the mark, so every
 * device agrees; hosts too old to store it get no button rather than a mark that vanishes.
 */
export function MarkDoneButton({
  serverId,
  workspaceId,
  done,
  size,
  testID,
}: {
  serverId: string;
  workspaceId: string;
  /** True offers to reopen a session marked done. */
  done: boolean;
  size: "xs" | "sm" | "md";
  testID: string;
}) {
  const { t } = useTranslation();
  const client = useHostRuntimeClient(serverId);
  const isSupported = useHostFeature(serverId, "workspaceDone");
  const [pending, setPending] = useState(false);
  const press = useCallback(() => {
    if (!client) return;
    setPending(true);
    client
      .setWorkspaceDone(workspaceId, !done)
      .catch(console.error)
      .finally(() => setPending(false));
  }, [client, done, workspaceId]);

  if (!isSupported || !client) return null;
  return (
    <Button
      variant="ghost"
      size={size}
      onPress={press}
      loading={pending}
      disabled={pending}
      testID={`${testID}-${done ? "reopen" : "done"}`}
    >
      {done ? t("leitstand.board.reopen") : t("leitstand.board.markDone")}
    </Button>
  );
}

import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useToast } from "@/contexts/toast-api-context";
import { useStableEvent } from "@/hooks/use-stable-event";
import { coalesceRuns } from "./model";
import { ShareTargetSheet } from "./sheet";
import { readPendingShare, subscribeToShares } from "./source";
import { offerShare, useShareIntakeStore } from "./store";

/**
 * Receives files, text and links shared from other apps (the system share sheet) and asks where
 * they go. Mounted once at the app root so a share lands whichever screen is open.
 */
export function ShareIntakeHost() {
  const { t } = useTranslation();
  const toast = useToast();
  const share = useShareIntakeStore((state) => state.pending);

  const readShare = useStableEvent(async () => {
    const { share: incoming, filesUnreadable } = await readPendingShare();
    if (filesUnreadable) toast.error(t("shareIntake.readFailed"));
    if (incoming) offerShare(incoming);
  });

  useEffect(() => {
    const check = coalesceRuns(readShare);
    const run = () => {
      check().catch((error: unknown) => {
        console.warn("[ShareIntake] Failed to read a share", error);
      });
    };
    // A cold start from the share sheet has the share waiting before any event fires.
    run();
    return subscribeToShares(run);
  }, [readShare]);

  return <ShareTargetSheet share={share} />;
}

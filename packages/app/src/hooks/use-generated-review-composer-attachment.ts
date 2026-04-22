import { useCallback } from "react";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useGeneratedReviewAttachment } from "@/hooks/use-generated-review-attachment";
import { usePanelStore } from "@/stores/panel-store";

interface UseGeneratedReviewComposerAttachmentInput {
  serverId: string;
  workspaceId?: string | null;
  cwd: string;
}

export function useGeneratedReviewComposerAttachment({
  serverId,
  workspaceId,
  cwd,
}: UseGeneratedReviewComposerAttachmentInput) {
  const isCompact = useIsCompactFormFactor();
  const openFileExplorerForCheckout = usePanelStore((state) => state.openFileExplorerForCheckout);
  const setExplorerTabForCheckout = usePanelStore((state) => state.setExplorerTabForCheckout);
  const generatedReview = useGeneratedReviewAttachment({
    serverId,
    cwd,
    workspaceId,
  });

  const openGeneratedReviewAttachment = useCallback(() => {
    if (!serverId || !cwd) {
      return;
    }
    const checkout = {
      serverId,
      cwd,
      isGit: generatedReview.isGit,
    };
    openFileExplorerForCheckout({
      checkout,
      isCompact,
    });
    setExplorerTabForCheckout({
      ...checkout,
      tab: "changes",
    });
  }, [
    cwd,
    generatedReview.isGit,
    isCompact,
    openFileExplorerForCheckout,
    serverId,
    setExplorerTabForCheckout,
  ]);

  return {
    attachment: generatedReview.attachment,
    openAttachment: openGeneratedReviewAttachment,
  };
}

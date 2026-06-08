export interface BottomSheetController {
  present(): void;
  dismiss(): void;
}

export interface BottomSheetVisibilityInput {
  visible: boolean;
  isEnabled?: boolean;
}

export interface BottomSheetVisibilityTracker {
  attachController(controller: BottomSheetController | null): void;
  syncDesired(input: BottomSheetVisibilityInput): void;
  handleSheetIndexChange(index: number): void;
  handleSheetDismiss(): void;
}

type BottomSheetPhase = "closed" | "presenting" | "presented" | "dismissing";

export function createBottomSheetVisibilityTracker(opts: {
  onClose: () => void;
}): BottomSheetVisibilityTracker {
  let controller: BottomSheetController | null = null;
  let visible = false;
  let isEnabled: boolean | undefined;
  let phase: BottomSheetPhase = "closed";
  let hasNotifiedClose = false;

  function present(): void {
    if (!controller || phase !== "closed") return;
    phase = "presenting";
    hasNotifiedClose = false;
    controller.present();
  }

  function dismiss(): void {
    if (!controller || phase === "closed" || phase === "dismissing") return;
    phase = "dismissing";
    controller.dismiss();
  }

  function notifyClose(): void {
    if (hasNotifiedClose) return;
    hasNotifiedClose = true;
    opts.onClose();
  }

  return {
    attachController(next) {
      controller = next;
      if (next && visible && isEnabled !== false) {
        present();
      }
    },
    syncDesired(next) {
      visible = next.visible;
      isEnabled = next.isEnabled;
      if (isEnabled === false) return;
      if (visible) {
        present();
        return;
      }
      if (phase === "dismissing") {
        phase = "closed";
        hasNotifiedClose = false;
        return;
      }
      dismiss();
    },
    handleSheetIndexChange(index) {
      if (index !== -1) {
        if (phase === "presenting" || phase === "dismissing") {
          phase = "presented";
        }
        return;
      }
      if (phase === "presenting" || phase === "presented") {
        phase = "dismissing";
      }
    },
    handleSheetDismiss() {
      if (visible) {
        phase = "dismissing";
        notifyClose();
        return;
      }
      phase = "closed";
      hasNotifiedClose = false;
    },
  };
}

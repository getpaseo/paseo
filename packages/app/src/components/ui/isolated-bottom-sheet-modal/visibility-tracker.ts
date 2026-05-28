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

export function createBottomSheetVisibilityTracker(opts: {
  onClose: () => void;
}): BottomSheetVisibilityTracker {
  let controller: BottomSheetController | null = null;
  let visible = false;
  let isEnabled: boolean | undefined;
  let isPresented = false;
  let hasNotifiedClose = false;

  function present(): void {
    if (!controller || isPresented) return;
    isPresented = true;
    hasNotifiedClose = false;
    controller.present();
  }

  function dismiss(): void {
    if (!controller || !isPresented) return;
    isPresented = false;
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
      dismiss();
    },
    handleSheetIndexChange(index) {
      if (index === -1 && visible) {
        notifyClose();
      }
    },
    handleSheetDismiss() {
      isPresented = false;
      if (visible) {
        notifyClose();
        return;
      }
      hasNotifiedClose = false;
    },
  };
}

export interface BottomSheetController {
  present(): void;
  dismiss(): void;
}

export interface BottomSheetVisibilityInput {
  visible: boolean;
  isEnabled?: boolean;
}

/**
 * The system Back press, as the tracker needs it.
 *
 * A sheet is presented through `@gorhom/portal`, which renders it into the app's own view tree
 * rather than a native modal window, so Android delivers Back to the navigator underneath it
 * unless something on top claims the press first.
 *
 * `subscribe` registers a listener and returns its removal. The listener returns `true` when it
 * claims the press. Listeners are offered the press newest-first, so a tracker holds its
 * subscription only while its sheet is on screen, and a stacked sheet answers before the one
 * below it.
 */
export interface BackPressSource {
  subscribe(onBackPress: () => boolean): () => void;
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
  backPress?: BackPressSource;
}): BottomSheetVisibilityTracker {
  let controller: BottomSheetController | null = null;
  let visible = false;
  let isEnabled: boolean | undefined;
  let phase: BottomSheetPhase = "closed";
  let hasNotifiedClose = false;
  let releaseBackPress: (() => void) | null = null;

  function setPhase(next: BottomSheetPhase): void {
    phase = next;
    syncBackPress();
  }

  /** Holds the Back press for exactly the window the sheet is on screen, and no longer. */
  function syncBackPress(): void {
    const wantsBackPress = phase === "presented" && controller !== null;
    if (wantsBackPress === (releaseBackPress !== null)) return;
    if (!wantsBackPress) {
      releaseBackPress?.();
      releaseBackPress = null;
      return;
    }
    releaseBackPress =
      opts.backPress?.subscribe(() => {
        dismiss();
        return true;
      }) ?? null;
  }

  function present(): void {
    if (!controller || phase !== "closed") return;
    hasNotifiedClose = false;
    setPhase("presenting");
    controller.present();
  }

  function dismiss(): void {
    if (!controller || phase === "closed" || phase === "dismissing") return;
    setPhase("dismissing");
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
      // A sheet that left the tree cannot answer, so it lets go of the press without changing
      // phase: the parent has not acknowledged the dismissal yet.
      syncBackPress();
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
        setPhase("closed");
        hasNotifiedClose = false;
        return;
      }
      dismiss();
    },
    handleSheetIndexChange(index) {
      if (index !== -1) {
        if (phase === "presenting" || phase === "dismissing") {
          setPhase("presented");
        }
        return;
      }
      if (phase === "presenting" || phase === "presented") {
        setPhase("dismissing");
      }
    },
    handleSheetDismiss() {
      if (visible) {
        setPhase("dismissing");
        notifyClose();
        return;
      }
      setPhase("closed");
      hasNotifiedClose = false;
    },
  };
}

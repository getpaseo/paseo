// Normal drop springs settle within this grace period; a longer wait leaves the app unusable.
export const DRAG_RELEASE_RECOVERY_DELAY_MS = 1_500;

export interface DragReleaseRecovery {
  dragBegan: () => void;
  fingerReleased: () => void;
  dragFinished: () => void;
  dispose: () => void;
}

export function createDragReleaseRecovery(onRecover: () => void): DragReleaseRecovery {
  let dragActive = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const clearRecoveryTimer = () => {
    if (timer === null) return;
    clearTimeout(timer);
    timer = null;
  };

  const dragFinished = () => {
    dragActive = false;
    clearRecoveryTimer();
  };

  return {
    dragBegan() {
      dragActive = true;
      clearRecoveryTimer();
    },
    fingerReleased() {
      if (!dragActive || timer !== null) return;
      timer = setTimeout(() => {
        timer = null;
        if (!dragActive) return;
        dragActive = false;
        onRecover();
      }, DRAG_RELEASE_RECOVERY_DELAY_MS);
    },
    dragFinished,
    dispose: dragFinished,
  };
}

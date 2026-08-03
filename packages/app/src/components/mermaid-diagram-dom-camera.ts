export interface MermaidCameraState {
  canZoomIn: boolean;
  canZoomOut: boolean;
}

interface MermaidDomCameraInput {
  panBehavior?: MermaidPanBehavior;
  viewport: HTMLElement;
  canvas: HTMLElement;
  onStateChange: (state: MermaidCameraState) => void;
}

interface CameraTransition {
  durationMs: number;
  easing: string;
}

interface ApplyCameraOptions {
  allowsOverscroll?: boolean;
  transition?: CameraTransition;
}

interface CameraPointer {
  timestamp: number;
  x: number;
  y: number;
}

export interface MermaidDomCamera {
  destroy: () => void;
  fit: () => void;
  setPanBehavior: (behavior: MermaidPanBehavior) => void;
  setContentSize: (width: number, height: number) => void;
  zoomIn: () => void;
  zoomOut: () => void;
}

export type MermaidPanBehavior = "clamped" | "rubber-band";

const ZOOM_STEP = 1.25;
const MAX_ZOOM_FROM_FIT = 4;
const CAMERA_EPSILON = 0.001;
const PAN_EDGE_INSET_PX = 24;
const RUBBER_BAND_RESISTANCE = 0.22;
const MAX_PAN_VELOCITY_PX_PER_MS = 2.4;
const MIN_MOMENTUM_VELOCITY_PX_PER_MS = 0.02;
const MOMENTUM_STOP_VELOCITY_PX_PER_MS = 0.01;
const MOMENTUM_DECELERATION_PER_MS = 0.0045;
const SPRING_STIFFNESS_PER_MS = 0.00008;
const SPRING_DAMPING_PER_MS = 0.012;
const SPRING_STOP_DISTANCE_PX = 0.5;
const MAX_FRAME_DURATION_MS = 32;
const MAX_RELEASE_DELAY_MS = 80;
const SMOOTH_TRANSITION = {
  durationMs: 180,
  easing: "cubic-bezier(0.22, 1, 0.36, 1)",
} as const;

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}

export function createMermaidDomCamera({
  panBehavior = "clamped",
  viewport,
  canvas,
  onStateChange,
}: MermaidDomCameraInput): MermaidDomCamera {
  let contentWidth = 1;
  let contentHeight = 1;
  let fitScale = 1;
  let scale = 1;
  let translateX = 0;
  let translateY = 0;
  let previousState: MermaidCameraState | null = null;
  const pointers = new Map<number, CameraPointer>();
  let previousPinchDistance: number | null = null;
  let transitionTimer: number | null = null;
  let activePanBehavior = panBehavior;
  let kineticFrame: number | null = null;
  let panVelocityX = 0;
  let panVelocityY = 0;
  let lastPanMoveTimestamp = 0;

  function viewportSize() {
    return {
      width: Math.max(viewport.clientWidth, 1),
      height: Math.max(viewport.clientHeight, 1),
    };
  }

  function axisTranslation(viewportLength: number, contentLength: number, value: number): number {
    const scaledLength = contentLength * scale;
    if (scaledLength <= viewportLength) {
      return (viewportLength - scaledLength) / 2;
    }
    return clamp(value, viewportLength - scaledLength - PAN_EDGE_INSET_PX, PAN_EDGE_INSET_PX);
  }

  function rubberBandAxisTranslation(
    viewportLength: number,
    contentLength: number,
    value: number,
  ): number {
    const scaledLength = contentLength * scale;
    if (scaledLength <= viewportLength) {
      return (viewportLength - scaledLength) / 2;
    }
    const minimum = viewportLength - scaledLength - PAN_EDGE_INSET_PX;
    const maximum = PAN_EDGE_INSET_PX;
    if (value < minimum) {
      return minimum + (value - minimum) * RUBBER_BAND_RESISTANCE;
    }
    if (value > maximum) {
      return maximum + (value - maximum) * RUBBER_BAND_RESISTANCE;
    }
    return value;
  }

  function setTransition(transition?: CameraTransition): void {
    if (transitionTimer !== null) {
      window.clearTimeout(transitionTimer);
      transitionTimer = null;
    }
    if (!transition) {
      canvas.style.transition = "none";
      return;
    }
    canvas.style.transition = `transform ${transition.durationMs}ms ${transition.easing}`;
    transitionTimer = window.setTimeout(() => {
      canvas.style.transition = "none";
      transitionTimer = null;
    }, transition.durationMs);
  }

  function applyCamera({ allowsOverscroll = false, transition }: ApplyCameraOptions = {}): void {
    const size = viewportSize();
    setTransition(transition);
    let renderedX = translateX;
    let renderedY = translateY;
    if (allowsOverscroll) {
      renderedX = rubberBandAxisTranslation(size.width, contentWidth, translateX);
      renderedY = rubberBandAxisTranslation(size.height, contentHeight, translateY);
    } else {
      translateX = axisTranslation(size.width, contentWidth, translateX);
      translateY = axisTranslation(size.height, contentHeight, translateY);
      renderedX = translateX;
      renderedY = translateY;
    }
    canvas.style.transform = `translate3d(${renderedX}px, ${renderedY}px, 0) scale(${scale})`;
    viewport.style.touchAction = scale > fitScale + CAMERA_EPSILON ? "none" : "pan-y";

    const state = {
      canZoomIn: scale < fitScale * MAX_ZOOM_FROM_FIT - CAMERA_EPSILON,
      canZoomOut: scale > fitScale + CAMERA_EPSILON,
    };
    if (
      !previousState ||
      state.canZoomIn !== previousState.canZoomIn ||
      state.canZoomOut !== previousState.canZoomOut
    ) {
      previousState = state;
      onStateChange(state);
    }
  }

  function fitCamera(transition?: CameraTransition): void {
    const size = viewportSize();
    fitScale = Math.min(size.width / contentWidth, size.height / contentHeight);
    scale = fitScale;
    translateX = (size.width - contentWidth * scale) / 2;
    translateY = (size.height - contentHeight * scale) / 2;
    applyCamera({ transition });
  }

  function zoomTo(
    nextScale: number,
    centerX: number,
    centerY: number,
    transition?: CameraTransition,
  ): void {
    const clampedScale = clamp(nextScale, fitScale, fitScale * MAX_ZOOM_FROM_FIT);
    if (Math.abs(clampedScale - scale) < CAMERA_EPSILON) {
      return;
    }

    const ratio = clampedScale / scale;
    translateX = centerX - (centerX - translateX) * ratio;
    translateY = centerY - (centerY - translateY) * ratio;
    scale = clampedScale;
    applyCamera({ transition });
  }

  function zoomBy(factor: number, transition?: CameraTransition): void {
    const size = viewportSize();
    zoomTo(scale * factor, size.width / 2, size.height / 2, transition);
  }

  function panBy(deltaX: number, deltaY: number, allowsOverscroll = false): boolean {
    const previousX = translateX;
    const previousY = translateY;
    translateX += deltaX;
    translateY += deltaY;
    applyCamera({ allowsOverscroll });
    return translateX !== previousX || translateY !== previousY;
  }

  function hasOverscroll(): boolean {
    const size = viewportSize();
    const clampedX = axisTranslation(size.width, contentWidth, translateX);
    const clampedY = axisTranslation(size.height, contentHeight, translateY);
    return (
      Math.abs(clampedX - translateX) > CAMERA_EPSILON ||
      Math.abs(clampedY - translateY) > CAMERA_EPSILON
    );
  }

  function cancelKineticPan(): void {
    if (kineticFrame !== null) {
      window.cancelAnimationFrame(kineticFrame);
      kineticFrame = null;
    }
  }

  function startKineticPan(): void {
    cancelKineticPan();
    let previousFrameTimestamp: number | null = null;
    let springTargetX: number | null = null;
    let springTargetY: number | null = null;

    function animate(frameTimestamp: number): void {
      if (previousFrameTimestamp === null) {
        previousFrameTimestamp = frameTimestamp;
        kineticFrame = window.requestAnimationFrame(animate);
        return;
      }

      const elapsed = Math.min(frameTimestamp - previousFrameTimestamp, MAX_FRAME_DURATION_MS);
      previousFrameTimestamp = frameTimestamp;
      const size = viewportSize();
      const clampedX = axisTranslation(size.width, contentWidth, translateX);
      const clampedY = axisTranslation(size.height, contentHeight, translateY);
      if (springTargetX === null && Math.abs(clampedX - translateX) > CAMERA_EPSILON) {
        springTargetX = clampedX;
      }
      if (springTargetY === null && Math.abs(clampedY - translateY) > CAMERA_EPSILON) {
        springTargetY = clampedY;
      }
      const springX = springTargetX === null ? 0 : springTargetX - translateX;
      const springY = springTargetY === null ? 0 : springTargetY - translateY;

      if (springTargetX !== null) {
        panVelocityX += springX * SPRING_STIFFNESS_PER_MS * elapsed;
        panVelocityX *= Math.exp(-SPRING_DAMPING_PER_MS * elapsed);
      } else {
        panVelocityX *= Math.exp(-MOMENTUM_DECELERATION_PER_MS * elapsed);
      }
      if (springTargetY !== null) {
        panVelocityY += springY * SPRING_STIFFNESS_PER_MS * elapsed;
        panVelocityY *= Math.exp(-SPRING_DAMPING_PER_MS * elapsed);
      } else {
        panVelocityY *= Math.exp(-MOMENTUM_DECELERATION_PER_MS * elapsed);
      }

      const previousX = translateX;
      const previousY = translateY;
      translateX += panVelocityX * elapsed;
      translateY += panVelocityY * elapsed;
      if (springTargetX !== null) {
        const previousDistance = springTargetX - previousX;
        const nextDistance = springTargetX - translateX;
        const crossedBoundary = previousDistance * nextDistance <= 0;
        const reachedBoundary = Math.abs(nextDistance) < SPRING_STOP_DISTANCE_PX;
        if (crossedBoundary || reachedBoundary) {
          translateX = springTargetX;
          panVelocityX = 0;
          springTargetX = null;
        }
      }
      if (springTargetY !== null) {
        const previousDistance = springTargetY - previousY;
        const nextDistance = springTargetY - translateY;
        const crossedBoundary = previousDistance * nextDistance <= 0;
        const reachedBoundary = Math.abs(nextDistance) < SPRING_STOP_DISTANCE_PX;
        if (crossedBoundary || reachedBoundary) {
          translateY = springTargetY;
          panVelocityY = 0;
          springTargetY = null;
        }
      }
      applyCamera({ allowsOverscroll: true });

      const settledX = axisTranslation(size.width, contentWidth, translateX);
      const settledY = axisTranslation(size.height, contentHeight, translateY);
      const distanceFromBounds = Math.hypot(settledX - translateX, settledY - translateY);
      const velocity = Math.hypot(panVelocityX, panVelocityY);
      const isSettled =
        velocity < MOMENTUM_STOP_VELOCITY_PX_PER_MS && distanceFromBounds < SPRING_STOP_DISTANCE_PX;
      if (isSettled) {
        translateX = settledX;
        translateY = settledY;
        applyCamera();
        kineticFrame = null;
        return;
      }
      kineticFrame = window.requestAnimationFrame(animate);
    }

    kineticFrame = window.requestAnimationFrame(animate);
  }

  function pointerPosition(event: { clientX: number; clientY: number }) {
    const bounds = viewport.getBoundingClientRect();
    return { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
  }

  function handleWheel(event: WheelEvent): void {
    if (event.ctrlKey || event.metaKey) {
      const point = pointerPosition(event);
      zoomTo(scale * Math.exp(-event.deltaY * 0.01), point.x, point.y);
      event.preventDefault();
      return;
    }

    if (scale > fitScale + CAMERA_EPSILON && panBy(-event.deltaX, -event.deltaY)) {
      event.preventDefault();
    }
  }

  function handlePointerDown(event: PointerEvent): void {
    const canDrag = scale > fitScale + CAMERA_EPSILON;
    if (!canDrag && event.pointerType !== "touch") {
      return;
    }
    cancelKineticPan();
    panVelocityX = 0;
    panVelocityY = 0;
    const point = pointerPosition(event);
    pointers.set(event.pointerId, { ...point, timestamp: event.timeStamp });
    if (canDrag) {
      setTransition();
      viewport.setPointerCapture(event.pointerId);
    }
  }

  function handlePointerMove(event: PointerEvent): void {
    const previous = pointers.get(event.pointerId);
    if (!previous) {
      return;
    }

    const point = pointerPosition(event);
    const current = { ...point, timestamp: event.timeStamp };
    pointers.set(event.pointerId, current);
    const activePointers = [...pointers.values()];
    if (activePointers.length >= 2) {
      panVelocityX = 0;
      panVelocityY = 0;
      const [first, second] = activePointers;
      const distance = Math.hypot(second.x - first.x, second.y - first.y);
      const centerX = (first.x + second.x) / 2;
      const centerY = (first.y + second.y) / 2;
      if (previousPinchDistance !== null && previousPinchDistance > 0) {
        zoomTo(scale * (distance / previousPinchDistance), centerX, centerY);
      }
      previousPinchDistance = distance;
      event.preventDefault();
      return;
    }

    previousPinchDistance = null;
    if (scale > fitScale + CAMERA_EPSILON) {
      const deltaX = current.x - previous.x;
      const deltaY = current.y - previous.y;
      const elapsed = Math.max(current.timestamp - previous.timestamp, 1);
      const instantVelocityX = clamp(
        deltaX / elapsed,
        -MAX_PAN_VELOCITY_PX_PER_MS,
        MAX_PAN_VELOCITY_PX_PER_MS,
      );
      const instantVelocityY = clamp(
        deltaY / elapsed,
        -MAX_PAN_VELOCITY_PX_PER_MS,
        MAX_PAN_VELOCITY_PX_PER_MS,
      );
      const velocityBlend = Math.min(elapsed / MAX_FRAME_DURATION_MS, 1);
      panVelocityX += (instantVelocityX - panVelocityX) * velocityBlend;
      panVelocityY += (instantVelocityY - panVelocityY) * velocityBlend;
      lastPanMoveTimestamp = current.timestamp;
      panBy(deltaX, deltaY, activePanBehavior === "rubber-band");
      event.preventDefault();
    }
  }

  function releasePointer(event: PointerEvent): void {
    pointers.delete(event.pointerId);
    if (pointers.size < 2) {
      previousPinchDistance = null;
    }
    if (pointers.size !== 0 || activePanBehavior !== "rubber-band") {
      return;
    }
    if (event.timeStamp - lastPanMoveTimestamp > MAX_RELEASE_DELAY_MS) {
      panVelocityX = 0;
      panVelocityY = 0;
    }
    const hasMomentum = Math.hypot(panVelocityX, panVelocityY) >= MIN_MOMENTUM_VELOCITY_PX_PER_MS;
    if (hasMomentum || hasOverscroll()) {
      startKineticPan();
    }
  }

  viewport.addEventListener("wheel", handleWheel, { passive: false });
  viewport.addEventListener("pointerdown", handlePointerDown);
  viewport.addEventListener("pointermove", handlePointerMove);
  viewport.addEventListener("pointerup", releasePointer);
  viewport.addEventListener("pointercancel", releasePointer);

  return {
    destroy() {
      cancelKineticPan();
      if (transitionTimer !== null) {
        window.clearTimeout(transitionTimer);
      }
      viewport.removeEventListener("wheel", handleWheel);
      viewport.removeEventListener("pointerdown", handlePointerDown);
      viewport.removeEventListener("pointermove", handlePointerMove);
      viewport.removeEventListener("pointerup", releasePointer);
      viewport.removeEventListener("pointercancel", releasePointer);
    },
    fit() {
      fitCamera(SMOOTH_TRANSITION);
    },
    setPanBehavior(behavior) {
      activePanBehavior = behavior;
      if (behavior === "clamped") {
        cancelKineticPan();
        applyCamera();
      }
    },
    setContentSize(width, height) {
      contentWidth = Math.max(width, 1);
      contentHeight = Math.max(height, 1);
      canvas.style.width = `${contentWidth}px`;
      canvas.style.height = `${contentHeight}px`;
      fitCamera();
    },
    zoomIn() {
      zoomBy(ZOOM_STEP, SMOOTH_TRANSITION);
    },
    zoomOut() {
      zoomBy(1 / ZOOM_STEP, SMOOTH_TRANSITION);
    },
  };
}

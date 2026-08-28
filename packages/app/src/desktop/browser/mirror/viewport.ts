export interface PaneSize {
  width: number;
  height: number;
}

export interface GuestViewport {
  deviceWidth: number;
  deviceHeight: number;
}

export interface ViewportFit {
  scale: number;
  offsetX: number;
  offsetY: number;
}

export interface GuestPoint {
  x: number;
  y: number;
}

/**
 * The frame is letterboxed inside the pane at the guest's aspect ratio. The
 * captured JPEG is scaled by CDP and is not the guest size, so mapping goes
 * through the frame's reported device dimensions instead.
 */
export function fitViewport(pane: PaneSize, guest: GuestViewport): ViewportFit {
  const scale = Math.min(pane.width / guest.deviceWidth, pane.height / guest.deviceHeight);
  return {
    scale,
    offsetX: (pane.width - guest.deviceWidth * scale) / 2,
    offsetY: (pane.height - guest.deviceHeight * scale) / 2,
  };
}

export function toGuestPoint(
  panePoint: GuestPoint,
  fit: ViewportFit,
  guest: GuestViewport,
): GuestPoint {
  return {
    x: clamp((panePoint.x - fit.offsetX) / fit.scale, guest.deviceWidth),
    y: clamp((panePoint.y - fit.offsetY) / fit.scale, guest.deviceHeight),
  };
}

function clamp(value: number, max: number): number {
  return Math.min(Math.max(value, 0), max);
}

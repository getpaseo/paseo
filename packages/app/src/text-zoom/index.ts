import { hydrateTextZoom } from "./store";

export { TextZoomArea } from "./area";
export { useScopedTextZoom } from "./scope";
export { anchorScrollOffset } from "./live";
export { startTextZoomPinch, touchDistance, type TextZoomPinchSession } from "./pinch-session";
export { formatTextZoom, isTextZoomSurface, zoomedFontSize, type TextZoomSurface } from "./model";
export {
  enablePinchTextZoom,
  getTextZoom,
  getTextZoomPinch,
  isPinchTextZoomEnabled,
  setTextZoom,
  subscribeTextZoom,
  useTextZoom,
  useTextZoomPinching,
} from "./store";

void hydrateTextZoom();

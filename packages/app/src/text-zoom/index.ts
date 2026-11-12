import { hydrateTextZoom } from "./store";

export { TextZoomArea } from "./area";
export { useScopedTextZoom } from "./scope";
export { formatTextZoom, isTextZoomSurface, zoomedFontSize, type TextZoomSurface } from "./model";
export {
  enablePinchTextZoom,
  getTextZoom,
  setTextZoom,
  subscribeTextZoom,
  useTextZoom,
} from "./store";

void hydrateTextZoom();

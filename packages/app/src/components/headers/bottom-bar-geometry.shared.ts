import type { ContentBandGeometry, ContentBandRect } from "./content-band-geometry.shared";

export interface BottomBarGeometry {
  bounds: ContentBandRect;
  bar: ContentBandRect;
  horizontal?: Pick<ContentBandGeometry, "margins" | "exclusions" | "placementBounds">;
}

export interface BottomBarGeometryProbeProps {
  extent: number;
  adaptHorizontalEdges?: boolean;
  onGeometryChange: (geometry: BottomBarGeometry) => void;
}

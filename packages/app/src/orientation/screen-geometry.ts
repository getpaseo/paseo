import { requireNativeModule } from "expo-modules-core";

interface AndroidPhysicalScreenSize {
  width: number;
  height: number;
}

interface PaseoScreenGeometryModule {
  getPhysicalScreenSize(): AndroidPhysicalScreenSize;
}

export function getAndroidPhysicalScreenSize(): AndroidPhysicalScreenSize {
  return requireNativeModule<PaseoScreenGeometryModule>(
    "PaseoScreenGeometry",
  ).getPhysicalScreenSize();
}

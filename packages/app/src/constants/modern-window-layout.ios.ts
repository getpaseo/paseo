import { requireNativeModule } from "expo-modules-core";

interface PaseoWindowLayoutModule {
  supportsModernWindowLayout(): boolean;
}

const windowLayout = requireNativeModule<PaseoWindowLayoutModule>("PaseoWindowLayout");

export const supportsModernWindowLayout: boolean = windowLayout.supportsModernWindowLayout();

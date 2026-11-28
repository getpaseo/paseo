import { isElectronRuntime } from "@/desktop/host";
export const usesDesktopBindings = isElectronRuntime();
export const supportsConfigurableComposerSendKeys = true;
export const hasSoftwareKeyboard = false;

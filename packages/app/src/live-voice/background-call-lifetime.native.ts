import { requireOptionalNativeModule } from "expo-modules-core";

interface PaseoBackgroundCallModule {
  begin(): Promise<void>;
  end(): Promise<void>;
}

function getOptionalBackgroundCallModule(): PaseoBackgroundCallModule | null {
  return requireOptionalNativeModule<PaseoBackgroundCallModule>("PaseoBackgroundCall");
}

function getBackgroundCallModule(): PaseoBackgroundCallModule {
  const backgroundCallModule = getOptionalBackgroundCallModule();
  if (!backgroundCallModule) {
    throw new Error("Live Voice background mode is unavailable in this app binary");
  }
  return backgroundCallModule;
}

export function isLiveVoiceBackgroundCallSupported(): boolean {
  return getOptionalBackgroundCallModule() !== null;
}

export async function beginLiveVoiceBackgroundCall(): Promise<void> {
  await getBackgroundCallModule().begin();
}

export async function endLiveVoiceBackgroundCall(): Promise<void> {
  await getBackgroundCallModule().end();
}

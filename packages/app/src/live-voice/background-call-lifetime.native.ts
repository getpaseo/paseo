import { requireNativeModule } from "expo-modules-core";

interface PaseoBackgroundCallModule {
  begin(): Promise<void>;
  end(): Promise<void>;
}

function getBackgroundCallModule(): PaseoBackgroundCallModule {
  // `requireNativeModule` throws when an OTA bundle is newer than the installed
  // binary. Resolve it only when Live Voice starts so the rest of the app can
  // still launch on binaries that predate this native module.
  return requireNativeModule<PaseoBackgroundCallModule>("PaseoBackgroundCall");
}

export async function beginLiveVoiceBackgroundCall(): Promise<void> {
  await getBackgroundCallModule().begin();
}

export async function endLiveVoiceBackgroundCall(): Promise<void> {
  await getBackgroundCallModule().end();
}

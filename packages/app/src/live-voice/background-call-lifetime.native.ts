import { requireNativeModule } from "expo-modules-core";

interface PaseoBackgroundCallModule {
  begin(): Promise<void>;
  end(): Promise<void>;
}

const module = requireNativeModule<PaseoBackgroundCallModule>("PaseoBackgroundCall");

export async function beginLiveVoiceBackgroundCall(): Promise<void> {
  await module.begin();
}

export async function endLiveVoiceBackgroundCall(): Promise<void> {
  await module.end();
}

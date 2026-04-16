import { Asset } from "expo-asset";
import { File } from "expo-file-system";
import { isWeb } from "@/constants/platform";
export { parsePcm16Wav, type Pcm16Wav } from "@/utils/pcm16-wav";

export const THINKING_TONE_REPEAT_GAP_MS = 350;

let thinkingToneArrayBufferPromise: Promise<ArrayBuffer> | null = null;

async function readThinkingToneArrayBuffer(): Promise<ArrayBuffer> {
  const toneModule = require("../../assets/audio/thinking-tone.wav");
  const asset = Asset.fromModule(toneModule);

  if (isWeb) {
    const response = await fetch(asset.uri);
    if (!response.ok) {
      throw new Error(`Failed to fetch thinking tone asset: ${response.status}`);
    }
    return await response.arrayBuffer();
  }

  const resolvedAsset = asset.localUri ? asset : await asset.downloadAsync();
  const fileUri = resolvedAsset.localUri ?? resolvedAsset.uri;
  const file = new File(fileUri);
  return await file.arrayBuffer();
}

export async function loadThinkingToneArrayBuffer(): Promise<ArrayBuffer> {
  if (!thinkingToneArrayBufferPromise) {
    thinkingToneArrayBufferPromise = readThinkingToneArrayBuffer();
  }
  return await thinkingToneArrayBufferPromise;
}

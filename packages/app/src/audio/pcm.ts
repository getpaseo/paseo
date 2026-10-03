/** Wrap the voice protocol's mono PCM16 LE bytes for a file decoder. */
export function pcmToWav(bytes: Uint8Array, mimeType: string): Uint8Array<ArrayBuffer> {
  const sampleRate = Number(/(?:^|;)rate=(\d+)/i.exec(mimeType)?.[1] ?? 24000);
  if (
    !Number.isSafeInteger(sampleRate) ||
    sampleRate <= 0 ||
    sampleRate > 192000 ||
    bytes.length % 2
  ) {
    throw new Error("Invalid PCM16 audio");
  }
  const wav = new Uint8Array(44 + bytes.length);
  const view = new DataView(wav.buffer);
  const tag = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i++) wav[offset + i] = value.charCodeAt(i);
  };
  tag(0, "RIFF");
  view.setUint32(4, 36 + bytes.length, true);
  tag(8, "WAVE");
  tag(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  tag(36, "data");
  view.setUint32(40, bytes.length, true);
  wav.set(bytes, 44);
  return wav;
}

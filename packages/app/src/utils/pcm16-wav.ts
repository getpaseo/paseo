export interface Pcm16Wav {
  sampleRate: number;
  samples: Int16Array;
}

const WAV_HEADER_BYTES = 44;

/** Wraps mono PCM16 samples in a canonical 44-byte RIFF/WAVE header. */
export function encodePcm16Wav(wav: Pcm16Wav): Uint8Array<ArrayBuffer> {
  const dataSize = wav.samples.length * 2;
  const bytes = new Uint8Array(WAV_HEADER_BYTES + dataSize);
  const view = new DataView(bytes.buffer);

  function writeAscii(offset: number, value: string): void {
    for (let i = 0; i < value.length; i += 1) {
      view.setUint8(offset + i, value.charCodeAt(i));
    }
  }

  writeAscii(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(8, "WAVE");
  writeAscii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, wav.sampleRate, true);
  view.setUint32(28, wav.sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(36, "data");
  view.setUint32(40, dataSize, true);

  for (let i = 0; i < wav.samples.length; i += 1) {
    view.setInt16(WAV_HEADER_BYTES + i * 2, wav.samples[i] ?? 0, true);
  }

  return bytes;
}

export function parsePcm16Wav(buffer: ArrayBuffer): Pcm16Wav | null {
  if (buffer.byteLength < 44) {
    return null;
  }

  const view = new DataView(buffer);

  function readAscii(offset: number, length: number): string {
    let out = "";
    for (let i = 0; i < length; i += 1) {
      out += String.fromCharCode(view.getUint8(offset + i));
    }
    return out;
  }

  if (readAscii(0, 4) !== "RIFF" || readAscii(8, 4) !== "WAVE") {
    return null;
  }

  let offset = 12;
  let channels = 0;
  let sampleRate = 0;
  let bitsPerSample = 0;
  let dataOffset = 0;
  let dataSize = 0;

  while (offset + 8 <= buffer.byteLength) {
    const chunkId = readAscii(offset, 4);
    const chunkSize = view.getUint32(offset + 4, true);
    const chunkDataOffset = offset + 8;

    if (chunkDataOffset + chunkSize > buffer.byteLength) {
      return null;
    }

    if (chunkId === "fmt " && chunkSize >= 16) {
      const audioFormat = view.getUint16(chunkDataOffset, true);
      channels = view.getUint16(chunkDataOffset + 2, true);
      sampleRate = view.getUint32(chunkDataOffset + 4, true);
      bitsPerSample = view.getUint16(chunkDataOffset + 14, true);
      if (audioFormat !== 1) {
        return null;
      }
    }

    if (chunkId === "data") {
      dataOffset = chunkDataOffset;
      dataSize = chunkSize;
      break;
    }

    offset = chunkDataOffset + chunkSize + (chunkSize % 2);
  }

  if (!dataOffset || dataSize <= 0 || sampleRate <= 0 || bitsPerSample !== 16 || channels <= 0) {
    return null;
  }

  const sampleCount = Math.floor(dataSize / 2);
  const interleaved = new Int16Array(buffer, dataOffset, sampleCount);

  if (channels === 1) {
    return {
      sampleRate,
      samples: new Int16Array(interleaved),
    };
  }

  const frameCount = Math.floor(interleaved.length / channels);
  const mono = new Int16Array(frameCount);
  for (let frame = 0; frame < frameCount; frame += 1) {
    let sum = 0;
    for (let channel = 0; channel < channels; channel += 1) {
      sum += interleaved[frame * channels + channel] ?? 0;
    }
    mono[frame] = Math.round(sum / channels);
  }

  return {
    sampleRate,
    samples: mono,
  };
}

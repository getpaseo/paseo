export class Pcm16MonoResampler {
  private readonly inputRate: number;
  private readonly outputRate: number;
  private readonly step: number;
  private pos: number;
  private carrySample: number | null;

  constructor(params: { inputRate: number; outputRate: number }) {
    this.inputRate = params.inputRate;
    this.outputRate = params.outputRate;
    this.step = this.inputRate / this.outputRate;
    this.pos = 0;
    this.carrySample = null;
  }

  public reset(): void {
    this.pos = 0;
    this.carrySample = null;
  }

  public processChunk(pcm16le: Buffer): Buffer {
    if (pcm16le.length === 0) {
      return Buffer.alloc(0);
    }
    if (pcm16le.length % 2 !== 0) {
      throw new Error(`PCM16 chunk byteLength must be even, got ${pcm16le.length}`);
    }

    const srcChunk = new Int16Array(
      pcm16le.buffer,
      pcm16le.byteOffset,
      pcm16le.byteLength / 2
    );

    const hasCarry = this.carrySample !== null;
    const srcLen = srcChunk.length + (hasCarry ? 1 : 0);
    if (srcLen < 2) {
      this.carrySample = srcChunk.length ? srcChunk[srcChunk.length - 1] : this.carrySample;
      return Buffer.alloc(0);
    }

    const src = new Float32Array(srcLen);
    let offset = 0;
    if (hasCarry) {
      src[0] = (this.carrySample as number) / 32768;
      offset = 1;
    }
    for (let i = 0; i < srcChunk.length; i += 1) {
      src[offset + i] = srcChunk[i] / 32768;
    }

    const out: number[] = [];
    const maxPos = src.length - 1;

    while (this.pos < maxPos) {
      const i = Math.floor(this.pos);
      const frac = this.pos - i;
      const s0 = src[i]!;
      const s1 = src[i + 1]!;
      const sample = s0 + (s1 - s0) * frac;
      const clamped = Math.max(-1, Math.min(1, sample));
      const int16 = Math.round(clamped * 32767);
      out.push(int16);
      this.pos += this.step;
    }

    // Keep the last input sample as carry for the next chunk.
    const lastInput = srcChunk[srcChunk.length - 1]!;
    this.carrySample = lastInput;

    // Shift position so next chunk (which will include carry sample) continues smoothly.
    const shift = src.length - 1;
    this.pos = this.pos - shift;
    if (this.pos < 0) {
      // Guard against floating point drift.
      this.pos = 0;
    }

    const outArr = Int16Array.from(out);
    return Buffer.from(outArr.buffer, outArr.byteOffset, outArr.byteLength);
  }
}


export type LocalSpeechWorkerBytes = ArrayBuffer;

export function bufferToWorkerBytes(buffer: Buffer): LocalSpeechWorkerBytes {
  const bytes = new Uint8Array(buffer.byteLength);
  bytes.set(buffer);
  return bytes.buffer;
}

export function workerBytesToBuffer(bytes: LocalSpeechWorkerBytes): Buffer {
  return Buffer.from(bytes);
}

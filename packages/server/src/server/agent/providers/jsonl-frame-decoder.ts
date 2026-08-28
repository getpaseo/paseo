const V2_FRAME_BYTES = 1024 * 1024;
const V2_REASSEMBLED_BYTES = 64 * 1024 * 1024;
const V2_CHUNK_BYTES = 256 * 1024;
const V2_BASE64_CHARS = Math.ceil(V2_CHUNK_BYTES / 3) * 4;
const V2_MAX_CHUNKS = Math.ceil(V2_REASSEMBLED_BYTES / V2_CHUNK_BYTES);

export type JsonlFrameProblem =
  | "invalid-json"
  | "invalid-chunk"
  | "invalid-base64"
  | "out-of-order-chunk"
  | "chunk-length-mismatch"
  | "invalid-chunk-payload";

interface ChunkHeader {
  id: string;
  index: number;
  count: number;
  byteLength: number;
  data: string;
}

interface ChunkAssembly {
  id: string;
  count: number;
  byteLength: number;
  parts: Buffer[];
  bytes: number;
}

export function supportsJsonlRpcProtocolV2(message: Record<string, unknown>): boolean {
  return (
    message.type === "ready" &&
    Array.isArray(message.supportedProtocolVersions) &&
    message.supportedProtocolVersions.includes(2) &&
    message.maxFrameBytes === V2_FRAME_BYTES &&
    message.maxReassembledFrameBytes === V2_REASSEMBLED_BYTES
  );
}

function objectFrame(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function chunkHeader(frame: Record<string, unknown>): ChunkHeader | null {
  const { chunkId, index, count, byteLength, data } = frame;
  if (
    typeof chunkId !== "string" ||
    chunkId.length === 0 ||
    chunkId.length > 128 ||
    typeof index !== "number" ||
    !Number.isSafeInteger(index) ||
    index < 0 ||
    typeof count !== "number" ||
    !Number.isSafeInteger(count) ||
    count < 2 ||
    count > V2_MAX_CHUNKS ||
    index >= count ||
    typeof byteLength !== "number" ||
    !Number.isSafeInteger(byteLength) ||
    byteLength < V2_FRAME_BYTES ||
    byteLength > V2_REASSEMBLED_BYTES ||
    typeof data !== "string" ||
    data.length === 0
  ) {
    return null;
  }
  return { id: chunkId, index, count, byteLength, data };
}

function chunkBytes(data: string): Buffer | null {
  if (data.length > V2_BASE64_CHARS) return null;
  const bytes = Buffer.from(data, "base64");
  if (bytes.byteLength > V2_CHUNK_BYTES || bytes.toString("base64") !== data) return null;
  return bytes;
}

export class JsonlFrameDecoder {
  private lineBuffer = "";
  private assembly: ChunkAssembly | null = null;

  constructor(
    private readonly receiver: {
      frame(message: Record<string, unknown>): void;
      problem(problem: JsonlFrameProblem, detail?: unknown): void;
    },
  ) {}

  write(text: string): void {
    this.lineBuffer += text;
    let newline = this.lineBuffer.indexOf("\n");
    while (newline !== -1) {
      const line = this.lineBuffer.slice(0, newline).replace(/\r$/, "");
      this.lineBuffer = this.lineBuffer.slice(newline + 1);
      if (line.trim()) this.consumeLine(line);
      newline = this.lineBuffer.indexOf("\n");
    }
  }

  private consumeLine(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      this.receiver.problem("invalid-json", { error, line });
      return;
    }
    const frame = objectFrame(parsed);
    if (!frame) return;
    if (frame.type !== "rpc_chunk") {
      this.receiver.frame(frame);
      return;
    }
    this.consumeChunk(frame);
  }

  private consumeChunk(frame: Record<string, unknown>): void {
    const header = chunkHeader(frame);
    if (!header) {
      this.drop("invalid-chunk", frame);
      return;
    }
    const bytes = chunkBytes(header.data);
    if (!bytes) {
      this.drop("invalid-base64");
      return;
    }
    if (!this.assembly) {
      if (header.index !== 0) {
        this.receiver.problem("out-of-order-chunk");
        return;
      }
      this.assembly = {
        id: header.id,
        count: header.count,
        byteLength: header.byteLength,
        parts: [],
        bytes: 0,
      };
    }
    const assembly = this.assembly;
    if (
      assembly.id !== header.id ||
      assembly.count !== header.count ||
      assembly.byteLength !== header.byteLength ||
      assembly.parts.length !== header.index
    ) {
      this.drop("out-of-order-chunk");
      return;
    }
    assembly.parts.push(bytes);
    assembly.bytes += bytes.byteLength;
    if (assembly.bytes > assembly.byteLength) {
      this.drop("chunk-length-mismatch");
      return;
    }
    if (assembly.parts.length < assembly.count) return;
    this.assembly = null;
    if (assembly.bytes !== assembly.byteLength) {
      this.receiver.problem("chunk-length-mismatch");
      return;
    }
    this.finishAssembly(assembly.parts);
  }

  private finishAssembly(parts: Buffer[]): void {
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(parts));
      const frame = objectFrame(JSON.parse(text));
      if (frame) this.receiver.frame(frame);
      else this.receiver.problem("invalid-chunk-payload");
    } catch (error) {
      this.receiver.problem("invalid-chunk-payload", error);
    }
  }

  private drop(problem: JsonlFrameProblem, detail?: unknown): void {
    this.assembly = null;
    this.receiver.problem(problem, detail);
  }
}

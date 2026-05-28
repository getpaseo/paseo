import { z } from "zod";
import { asUint8Array } from "./terminal.js";

export const FileTransferOpcode = {
  FileBegin: 0x10,
  FileChunk: 0x11,
  FileEnd: 0x12,
} as const;

export type FileTransferOpcode = (typeof FileTransferOpcode)[keyof typeof FileTransferOpcode];

export const FileBeginMetadataSchema = z
  .object({
    mime: z.string().min(1),
    size: z.number().int().nonnegative(),
    encoding: z.enum(["utf-8", "binary"]),
    modifiedAt: z.string(),
  })
  .strict();

export interface FileBegin {
  opcode: typeof FileTransferOpcode.FileBegin;
  requestId: string;
  metadata: z.infer<typeof FileBeginMetadataSchema>;
  payload: Uint8Array;
}

export interface FileChunk {
  opcode: typeof FileTransferOpcode.FileChunk;
  requestId: string;
  payload: Uint8Array;
}

export interface FileEnd {
  opcode: typeof FileTransferOpcode.FileEnd;
  requestId: string;
  payload: Uint8Array;
}

export type FileTransferFrame = FileBegin | FileChunk | FileEnd;

type FileTransferFrameInput =
  | {
      opcode: typeof FileTransferOpcode.FileBegin;
      requestId: string;
      metadata: z.infer<typeof FileBeginMetadataSchema>;
    }
  | {
      opcode: typeof FileTransferOpcode.FileChunk;
      requestId: string;
      payload?: Uint8Array | ArrayBuffer | string;
    }
  | {
      opcode: typeof FileTransferOpcode.FileEnd;
      requestId: string;
    };

export function encodeFileTransferFrame(input: FileTransferFrameInput): Uint8Array {
  const requestId = encodeRequestId(input.requestId);

  if (input.opcode === FileTransferOpcode.FileBegin) {
    const metadata = encodeJsonPayload(input.metadata);
    if (metadata.byteLength > 0xffff) {
      throw new RangeError("FileBegin metadata is too long");
    }
    const bytes = new Uint8Array(4 + requestId.byteLength + metadata.byteLength);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    bytes[0] = input.opcode;
    bytes[1] = requestId.byteLength;
    bytes.set(requestId, 2);
    view.setUint16(2 + requestId.byteLength, metadata.byteLength);
    bytes.set(metadata, 4 + requestId.byteLength);
    return bytes;
  }

  const payload =
    input.opcode === FileTransferOpcode.FileChunk
      ? (asUint8Array(input.payload ?? new Uint8Array()) ?? new Uint8Array())
      : new Uint8Array();
  const bytes = new Uint8Array(2 + requestId.byteLength + payload.byteLength);
  bytes[0] = input.opcode;
  bytes[1] = requestId.byteLength;
  bytes.set(requestId, 2);
  bytes.set(payload, 2 + requestId.byteLength);
  return bytes;
}

export function decodeFileTransferFrame(bytes: Uint8Array): FileTransferFrame | null {
  if (bytes.byteLength < 2) {
    return null;
  }
  const opcode = bytes[0];
  if (!isFileTransferOpcode(opcode)) {
    return null;
  }
  const requestIdLength = bytes[1];
  if (requestIdLength === 0 || requestIdLength > bytes.byteLength - 2) {
    return null;
  }

  const requestId = decodeRequestId(bytes.subarray(2, 2 + requestIdLength));
  const body = bytes.subarray(2 + requestIdLength);

  if (opcode === FileTransferOpcode.FileBegin) {
    if (body.byteLength < 2) {
      return null;
    }
    const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
    const metadataLength = view.getUint16(0);
    if (metadataLength !== body.byteLength - 2) {
      return null;
    }
    const metadataBytes = body.subarray(2);
    const result = FileBeginMetadataSchema.safeParse(decodeJsonPayload(metadataBytes));
    return result.success
      ? { opcode, requestId, metadata: result.data, payload: new Uint8Array() }
      : null;
  }

  if (opcode === FileTransferOpcode.FileChunk) {
    return { opcode, requestId, payload: body };
  }

  if (body.byteLength !== 0) {
    return null;
  }
  return { opcode, requestId, payload: new Uint8Array() };
}

function isFileTransferOpcode(value: number): value is FileTransferOpcode {
  return (
    value === FileTransferOpcode.FileBegin ||
    value === FileTransferOpcode.FileChunk ||
    value === FileTransferOpcode.FileEnd
  );
}

function encodeJsonPayload(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

function encodeRequestId(requestId: string): Uint8Array {
  const bytes = new TextEncoder().encode(requestId);
  if (bytes.byteLength === 0) {
    throw new RangeError("File transfer requestId is required");
  }
  if (bytes.byteLength > 0xff) {
    throw new RangeError("File transfer requestId is too long");
  }
  return bytes;
}

function decodeRequestId(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

function decodeJsonPayload(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}

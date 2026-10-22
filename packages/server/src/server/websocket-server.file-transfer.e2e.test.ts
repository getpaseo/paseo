import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { WebSocket, type RawData } from "ws";
import {
  decodeFileTransferFrame,
  encodeFileTransferFrame,
  FileTransferOpcode,
} from "@getpaseo/protocol/binary-frames/index";
import { createTestPaseoDaemon, type TestPaseoDaemon } from "./test-utils/index.js";
import { WSOutboundMessageSchema, type WSOutboundMessage } from "./messages.js";

const TEST_TIMEOUT_MS = 30_000;
const FILE_SIZE = 8 * 1024 * 1024 + 123;

let daemon: TestPaseoDaemon | undefined;
const temporaryDirectories: string[] = [];
const sockets: WebSocket[] = [];

test(
  "a live upload limit rejects oversized files without closing the socket",
  async () => {
    daemon = await createTestPaseoDaemon();
    const source = await connectSocket(daemon.port, "upload-limit-client");
    sockets.push(source);
    await sendAndWait(
      source,
      {
        type: "session",
        message: {
          type: "set_daemon_config_request",
          requestId: "limit",
          config: { uploads: { maxFileBytes: 5 } },
        },
      },
      (message) =>
        message.type === "session" && message.message.type === "set_daemon_config_response",
    );
    const rejected = await sendAndWait(
      source,
      {
        type: "session",
        message: {
          type: "file.upload.request",
          requestId: "oversized",
          fileName: "large.txt",
          mimeType: "text/plain",
          size: 6,
          modifiedAt: new Date().toISOString(),
        },
      },
      (message) =>
        message.type === "session" &&
        message.message.type === "file.upload.response" &&
        message.message.payload.requestId === "oversized",
    );
    expect(rejected).toMatchObject({
      message: {
        payload: { file: null, error: "File is 6 bytes; configured upload limit is 5 bytes." },
      },
    });
    expect(existsSync(join(daemon.paseoHome, "uploads"))).toBe(false);
    const accepted = sendAndWait(
      source,
      {
        type: "session",
        message: {
          type: "file.upload.request",
          requestId: "accepted",
          fileName: "small.txt",
          mimeType: "text/plain",
          size: 5,
          modifiedAt: new Date().toISOString(),
        },
      },
      (message) =>
        message.type === "session" &&
        message.message.type === "file.upload.response" &&
        message.message.payload.requestId === "accepted",
    );
    source.send(
      encodeFileTransferFrame({
        opcode: FileTransferOpcode.FileBegin,
        requestId: "accepted",
        metadata: {
          mime: "text/plain",
          size: 5,
          encoding: "binary",
          modifiedAt: new Date().toISOString(),
          fileName: "small.txt",
        },
      }),
    );
    source.send(
      encodeFileTransferFrame({
        opcode: FileTransferOpcode.FileChunk,
        requestId: "accepted",
        payload: new TextEncoder().encode("hello"),
      }),
    );
    source.send(
      encodeFileTransferFrame({ opcode: FileTransferOpcode.FileEnd, requestId: "accepted" }),
    );
    expect(await accepted).toMatchObject({
      message: { payload: { error: null, file: { size: 5 } } },
    });
    expect(source.readyState).toBe(WebSocket.OPEN);
  },
  TEST_TIMEOUT_MS,
);

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate();
  await daemon?.close();
  daemon = undefined;
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

test(
  "a large file stays ordered, source-scoped, and does not block another socket",
  async () => {
    const cwd = mkdtempSync(join(tmpdir(), "paseo-large-file-transfer-"));
    temporaryDirectories.push(cwd);
    const expected = Buffer.alloc(FILE_SIZE);
    for (let index = 0; index < expected.length; index += 1) expected[index] = index % 251;
    writeFileSync(join(cwd, "large.bin"), expected);

    daemon = await createTestPaseoDaemon();
    const source = await connectSocket(daemon.port, "shared-file-client");
    const unrelated = await connectSocket(daemon.port, "shared-file-client");
    sockets.push(source, unrelated);

    let unrelatedBinaryFrames = 0;
    unrelated.on("message", (_data, isBinary) => {
      if (isBinary) unrelatedBinaryFrames += 1;
    });

    const transfer = receiveFileTransfer(source, "req-large-file");
    source.send(
      JSON.stringify({
        type: "session",
        message: {
          type: "file_explorer_request",
          cwd,
          path: "large.bin",
          mode: "file",
          acceptBinary: true,
          requestId: "req-large-file",
        },
      }),
    );

    await sendAndWait(
      unrelated,
      {
        type: "session",
        message: { type: "ping", requestId: "req-unrelated", clientSentAt: 1 },
      },
      (message) =>
        message.type === "session" &&
        message.message.type === "pong" &&
        message.message.payload.requestId === "req-unrelated",
    );

    const frames = await transfer;
    const chunks = frames.flatMap((frame) =>
      frame.opcode === FileTransferOpcode.FileChunk ? [frame.payload] : [],
    );
    expect(frames[0]?.opcode).toBe(FileTransferOpcode.FileBegin);
    expect(frames.at(-1)?.opcode).toBe(FileTransferOpcode.FileEnd);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.byteLength <= 256 * 1024)).toBe(true);
    expect(Buffer.compare(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))), expected)).toBe(
      0,
    );
    expect(source.readyState).toBe(WebSocket.OPEN);
    expect(unrelated.readyState).toBe(WebSocket.OPEN);
    expect(unrelatedBinaryFrames).toBe(0);
  },
  TEST_TIMEOUT_MS,
);

async function connectSocket(port: number, clientId: string): Promise<WebSocket> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  await sendAndWait(
    socket,
    { type: "hello", clientId, clientType: "browser", protocolVersion: 1 },
    (message) =>
      message.type === "session" &&
      message.message.type === "status" &&
      message.message.payload.status === "server_info",
  );
  return socket;
}

function receiveFileTransfer(source: WebSocket, requestId: string) {
  return new Promise<NonNullable<ReturnType<typeof decodeFileTransferFrame>>[]>(
    (resolve, reject) => {
      const frames: NonNullable<ReturnType<typeof decodeFileTransferFrame>>[] = [];
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error("Timed out waiting for file transfer"));
      }, TEST_TIMEOUT_MS);
      const onMessage = (data: RawData, isBinary: boolean) => {
        if (!isBinary) return;
        const frame = decodeFileTransferFrame(new Uint8Array(data as Buffer));
        if (!frame || frame.requestId !== requestId) return;
        frames.push(frame);
        if (frame.opcode === FileTransferOpcode.FileEnd) {
          cleanup();
          resolve(frames);
        }
      };
      const onClose = () => {
        cleanup();
        reject(new Error("Socket closed during file transfer"));
      };
      const cleanup = () => {
        clearTimeout(timeout);
        source.off("message", onMessage);
        source.off("close", onClose);
      };
      source.on("message", onMessage);
      source.on("close", onClose);
    },
  );
}

function sendAndWait(
  socket: WebSocket,
  message: unknown,
  matches: (message: WSOutboundMessage) => boolean,
): Promise<WSOutboundMessage> {
  const response = new Promise<WSOutboundMessage>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for WebSocket message"));
    }, TEST_TIMEOUT_MS);
    const onMessage = (data: RawData, isBinary: boolean) => {
      if (isBinary) return;
      const parsed = WSOutboundMessageSchema.safeParse(JSON.parse(data.toString()));
      if (!parsed.success || !matches(parsed.data)) return;
      cleanup();
      resolve(parsed.data);
    };
    const cleanup = () => {
      clearTimeout(timeout);
      socket.off("message", onMessage);
    };
    socket.on("message", onMessage);
  });
  socket.send(JSON.stringify(message));
  return response;
}

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, type ReadStream } from "fs";
import { open, type FileHandle } from "fs/promises";
import { once } from "node:events";
import { get, ServerResponse } from "node:http";
import { tmpdir } from "os";
import path from "path";
import { createDaemonTestContext, type DaemonTestContext } from "../test-utils/index.js";

function tmpCwd(): string {
  return mkdtempSync(path.join(tmpdir(), "daemon-e2e-"));
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function observeDownload(filePath: string) {
  const probe = await open(filePath, "r");
  const prototype = Object.getPrototypeOf(probe) as FileHandle;
  await probe.close();

  const streamStarted = deferred<{
    handle: FileHandle;
    stream: ReadStream;
    closed: Promise<unknown[]>;
  }>();
  const responseAssigned = deferred<ServerResponse>();
  const responseClosed = deferred<void>();
  let downloadStream: ReadStream | null = null;
  let streamClosed: Promise<unknown[]> | null = null;

  const createReadStream = prototype.createReadStream;
  vi.spyOn(prototype, "createReadStream").mockImplementation(function (this: FileHandle, options) {
    // Pause the real file after one byte so cancellation cannot race with EOF.
    const stream = createReadStream.call(this, { ...options, highWaterMark: 1 });
    stream.once("data", () => stream.pause());
    downloadStream = stream;
    streamClosed = once(stream, "close");
    streamStarted.resolve({ handle: this, stream, closed: streamClosed });
    return stream;
  });

  const assignSocket = ServerResponse.prototype.assignSocket;
  vi.spyOn(ServerResponse.prototype, "assignSocket").mockImplementation(function (socket) {
    if (this.req.url?.startsWith("/api/files/download?")) {
      this.once("close", () => responseClosed.resolve());
      responseAssigned.resolve(this);
    }
    return assignSocket.call(this, socket);
  });

  return {
    prototype,
    streamStarted: streamStarted.promise,
    responseAssigned: responseAssigned.promise,
    responseClosed: responseClosed.promise,
    cleanup: async () => {
      downloadStream?.destroy();
      await streamClosed;
      vi.restoreAllMocks();
    },
  };
}

function pauseFileStat(prototype: FileHandle) {
  const started = deferred<FileHandle>();
  const resume = deferred<void>();
  const closed = deferred<void>();
  const stat = prototype.stat;
  vi.spyOn(prototype, "stat").mockImplementation(async function (this: FileHandle, options) {
    const result = await stat.call(this, options);
    const close = this.close;
    vi.spyOn(this, "close").mockImplementation(async () => {
      await close();
      closed.resolve();
    });
    started.resolve(this);
    await resume.promise;
    return result;
  });
  return { started: started.promise, resume: resume.resolve, closed: closed.promise };
}

// Use gpt-5.4-mini with low thinking preset for faster test execution
const CODEX_TEST_MODEL = "gpt-5.4-mini";
const CODEX_TEST_THINKING_OPTION_ID = "low";

describe("daemon E2E", () => {
  let ctx: DaemonTestContext;

  beforeEach(async () => {
    ctx = await createDaemonTestContext();
  });

  afterEach(async () => {
    await ctx.cleanup();
  }, 60000);

  describe("file download tokens", () => {
    test("closes the file stream when the HTTP client cancels a download", async () => {
      const cwd = tmpCwd();
      const filePath = path.join(cwd, "canceled.txt");
      writeFileSync(filePath, "download test payload", "utf-8");
      const tokenResponse = await ctx.client.requestDownloadToken(cwd, "canceled.txt");
      expect(tokenResponse.error).toBeNull();

      const download = await observeDownload(filePath);
      const request = get(
        `http://127.0.0.1:${ctx.daemon.port}/api/files/download?token=${tokenResponse.token}`,
      );
      try {
        const [response] = await once(request, "response");
        const [chunk] = await once(response, "data");
        const { handle, stream, closed } = await download.streamStarted;
        expect(response.statusCode).toBe(200);
        expect(chunk).toEqual(Buffer.from("d"));
        expect(stream.readableEnded).toBe(false);

        request.destroy();
        await download.responseClosed;

        expect(stream.destroyed).toBe(true);
        await closed;
        expect(stream.closed).toBe(true);
        expect(handle.fd).toBe(-1);
      } finally {
        request.destroy();
        await download.cleanup();
        rmSync(cwd, { recursive: true, force: true });
      }
    });

    test("closes the file when the HTTP client cancels before streaming starts", async () => {
      const cwd = tmpCwd();
      const filePath = path.join(cwd, "canceled-before-stream.txt");
      writeFileSync(filePath, "download test payload", "utf-8");
      const tokenResponse = await ctx.client.requestDownloadToken(
        cwd,
        "canceled-before-stream.txt",
      );
      expect(tokenResponse.error).toBeNull();

      const download = await observeDownload(filePath);
      const fileStat = pauseFileStat(download.prototype);

      const request = get(
        `http://127.0.0.1:${ctx.daemon.port}/api/files/download?token=${tokenResponse.token}`,
      );
      const canceled = new Error("Cancel download before file stat completes");
      const requestError = once(request, "error");
      const cleanupStarted = Promise.race([fileStat.closed, download.streamStarted]);
      try {
        const handle = await fileStat.started;
        await download.responseAssigned;
        request.destroy(canceled);
        const [error] = await requestError;
        expect(error).toBe(canceled);
        await download.responseClosed;

        fileStat.resume();
        await cleanupStarted;
        expect(handle.fd).toBe(-1);
      } finally {
        fileStat.resume();
        request.destroy();
        await cleanupStarted;
        await download.cleanup();
        rmSync(cwd, { recursive: true, force: true });
      }
    });

    test.each([
      { fileName: "download.txt", disposition: 'attachment; filename="download.txt"' },
      {
        fileName: "café.txt",
        disposition: "attachment; filename=\"caf?.txt\"; filename*=UTF-8''caf%C3%A9.txt",
      },
      {
        fileName: "中文报告 (最终版).txt",
        disposition:
          "attachment; filename=\"???? (???).txt\"; filename*=UTF-8''%E4%B8%AD%E6%96%87%E6%8A%A5%E5%91%8A%20%28%E6%9C%80%E7%BB%88%E7%89%88%29.txt",
      },
      {
        fileName: "報告書.md",
        disposition:
          "attachment; filename=\"???.md\"; filename*=UTF-8''%E5%A0%B1%E5%91%8A%E6%9B%B8.md",
      },
      {
        fileName: "보고서.txt",
        disposition:
          "attachment; filename=\"???.txt\"; filename*=UTF-8''%EB%B3%B4%EA%B3%A0%EC%84%9C.txt",
      },
      {
        fileName: "report-📄.txt",
        disposition:
          "attachment; filename=\"report-??.txt\"; filename*=UTF-8''report-%F0%9F%93%84.txt",
      },
    ])(
      "issues token over WS and downloads $fileName via HTTP",
      async ({ fileName, disposition }) => {
        const cwd = tmpCwd();
        try {
          const filePath = path.join(cwd, fileName);
          const fileContents = "download test payload";
          writeFileSync(filePath, fileContents, "utf-8");

          const agent = await ctx.client.createAgent({
            provider: "codex",
            model: CODEX_TEST_MODEL,
            thinkingOptionId: CODEX_TEST_THINKING_OPTION_ID,
            cwd,
            title: "Download Token Test Agent",
          });

          expect(agent.id).toMatch(
            /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
          );

          const tokenResponse = await ctx.client.requestDownloadToken(cwd, fileName);

          expect(tokenResponse.error).toBeNull();
          expect(tokenResponse.token).toMatch(
            /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
          );
          expect(tokenResponse.fileName).toBe(fileName);

          const response = await fetch(
            `http://127.0.0.1:${ctx.daemon.port}/api/files/download?token=${tokenResponse.token}`,
          );

          expect(response.status).toBe(200);
          expect(response.headers.get("content-type")).toBe(tokenResponse.mimeType);
          expect(response.headers.get("content-disposition")).toBe(disposition);

          const body = await response.text();
          expect(body).toBe(fileContents);
        } finally {
          rmSync(cwd, { recursive: true, force: true });
        }
      },
      60000,
    );

    test("rejects invalid token", async () => {
      const response = await fetch(
        `http://127.0.0.1:${ctx.daemon.port}/api/files/download?token=invalid-token`,
      );

      expect(response.status).toBe(403);
    }, 30000);

    test("rejects expired token", async () => {
      await ctx.cleanup();
      ctx = await createDaemonTestContext({ downloadTokenTtlMs: 50 });

      const cwd = tmpCwd();
      const filePath = path.join(cwd, "expired.txt");
      writeFileSync(filePath, "expired", "utf-8");

      await ctx.client.createAgent({
        provider: "codex",
        model: CODEX_TEST_MODEL,
        thinkingOptionId: CODEX_TEST_THINKING_OPTION_ID,
        cwd,
        title: "Expired Token Test Agent",
      });

      const tokenResponse = await ctx.client.requestDownloadToken(cwd, "expired.txt");

      expect(tokenResponse.error).toBeNull();
      expect(tokenResponse.token).toBeTruthy();

      await new Promise((resolve) => setTimeout(resolve, 150));

      const response = await fetch(
        `http://127.0.0.1:${ctx.daemon.port}/api/files/download?token=${tokenResponse.token}`,
      );

      expect(response.status).toBe(403);

      rmSync(cwd, { recursive: true, force: true });
    }, 60000);

    test("rejects paths outside the workspace cwd", async () => {
      const cwd = tmpCwd();
      await ctx.client.createAgent({
        provider: "codex",
        model: CODEX_TEST_MODEL,
        thinkingOptionId: CODEX_TEST_THINKING_OPTION_ID,
        cwd,
        title: "Outside Path Token Test Agent",
      });

      const tokenResponse = await ctx.client.requestDownloadToken(cwd, "../outside.txt");

      expect(tokenResponse.token).toBeNull();
      expect(tokenResponse.error).toBeTruthy();

      rmSync(cwd, { recursive: true, force: true });
    }, 60000);
  });
});

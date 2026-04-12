import { describe, expect, it, vi, beforeEach } from "vitest";
import pino from "pino";
import { FunASRSTT } from "./stt.js";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

describe("FunASRSTT", () => {
  const logger = pino({ level: "silent" });

  beforeEach(() => {
    mockFetch.mockReset();
  });

  it("has provider id 'funasr'", () => {
    const stt = new FunASRSTT({ url: "http://127.0.0.1:10095" }, logger);
    expect(stt.id).toBe("funasr");
  });

  it("creates a session that transcribes audio on commit", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ text: "你好世界" }),
    });

    const stt = new FunASRSTT({ url: "http://127.0.0.1:10095" }, logger);
    const session = stt.createSession({ logger });

    const transcripts: Array<{ transcript: string; isFinal: boolean }> = [];
    const committed: string[] = [];

    session.on("transcript", (payload: any) => transcripts.push(payload));
    session.on("committed", (payload: any) => committed.push(payload.segmentId));

    await session.connect();
    session.appendPcm16(Buffer.alloc(4800));
    session.commit();

    await new Promise((r) => setTimeout(r, 100));

    expect(committed).toHaveLength(1);
    expect(transcripts).toHaveLength(1);
    expect(transcripts[0].transcript).toBe("你好世界");
    expect(transcripts[0].isFinal).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("emits error when server is unreachable", async () => {
    mockFetch.mockRejectedValueOnce(new Error("ECONNREFUSED"));

    const stt = new FunASRSTT({ url: "http://127.0.0.1:10095" }, logger);
    const session = stt.createSession({ logger });

    const errors: Error[] = [];
    session.on("error", (err: Error) => errors.push(err));

    await session.connect();
    session.appendPcm16(Buffer.alloc(100));
    session.commit();

    await new Promise((r) => setTimeout(r, 100));

    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain("ECONNREFUSED");
  });

  it("emits empty transcript for empty audio without HTTP call", async () => {
    const stt = new FunASRSTT({ url: "http://127.0.0.1:10095" }, logger);
    const session = stt.createSession({ logger });

    const transcripts: Array<{
      transcript: string;
      isFinal: boolean;
      isLowConfidence?: boolean;
    }> = [];
    session.on("transcript", (payload: any) => transcripts.push(payload));
    session.on("committed", () => {});

    await session.connect();
    session.commit();

    await new Promise((r) => setTimeout(r, 50));

    expect(transcripts).toHaveLength(1);
    expect(transcripts[0].transcript).toBe("");
    expect(transcripts[0].isFinal).toBe(true);
    expect(transcripts[0].isLowConfidence).toBe(true);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

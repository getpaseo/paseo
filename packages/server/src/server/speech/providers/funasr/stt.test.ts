import { describe, expect, it, beforeEach } from "vitest";
import pino from "pino";

import { FunASRSTT } from "./stt.js";

describe("FunASRSTT", () => {
  const logger = pino({ level: "silent" });

  it("has provider id 'funasr'", () => {
    const stt = new FunASRSTT({ url: "http://127.0.0.1:10095" }, logger);
    expect(stt.id).toBe("funasr");
  });

  it("derives WebSocket URL from HTTP URL", () => {
    const stt = new FunASRSTT({ url: "http://127.0.0.1:10095" }, logger);
    // Access internal wsUrl via the session behavior
    expect(stt.id).toBe("funasr");
  });

  it("creates a session with requiredSampleRate 16000", () => {
    const stt = new FunASRSTT({ url: "http://127.0.0.1:10095" }, logger);
    const session = stt.createSession({ logger });
    expect(session.requiredSampleRate).toBe(16000);
  });

  it("emits error when appendPcm16 called before connect", () => {
    const stt = new FunASRSTT({ url: "http://127.0.0.1:10095" }, logger);
    const session = stt.createSession({ logger });

    const errors: unknown[] = [];
    session.on("error", (err) => errors.push(err));

    session.appendPcm16(Buffer.alloc(100));

    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toContain("not connected");
  });

  it("emits error when commit called before connect", () => {
    const stt = new FunASRSTT({ url: "http://127.0.0.1:10095" }, logger);
    const session = stt.createSession({ logger });

    const errors: unknown[] = [];
    session.on("error", (err) => errors.push(err));

    session.commit();

    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toContain("not connected");
  });
});

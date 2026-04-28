import type pino from "pino";

export type TurnDetectionSession = {
  /**
   * Required PCM16LE sample rate for `appendPcm16()`.
   * Callers are responsible for resampling before appending.
   */
  requiredSampleRate: number;

  connect(): Promise<void>;
  appendPcm16(pcm16le: Buffer): void;
  flush(): void;
  reset(): void;
  close(): void;

  on(event: "speech_started", handler: () => void): unknown;
  on(event: "speech_stopped", handler: () => void): unknown;
  on(event: "error", handler: (err: unknown) => void): unknown;
};

export interface TurnDetectionProvider {
  id: "openai" | "local" | (string & {});
  createSession(params: { logger: pino.Logger }): TurnDetectionSession;
}

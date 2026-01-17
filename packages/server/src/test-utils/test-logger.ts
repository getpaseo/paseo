import pino from "pino";

export function createTestLogger(): pino.Logger {
  return pino({ level: "silent" });
}

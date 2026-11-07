import type { Logger } from "@getpaseo/client/internal/daemon-client";

export function createHostLogger(
  readServerId: () => string | undefined,
  output: Pick<Console, "log" | "warn" | "error"> = console,
): Logger {
  const format = (record: object, message?: string): string => {
    const seen = new WeakSet<object>();
    const details = JSON.stringify(
      { serverId: readServerId(), ...record },
      (_key, value: unknown) => {
        if (value && typeof value === "object") {
          if (seen.has(value)) return "[Circular]";
          seen.add(value);
          if (value instanceof Error) {
            return {
              ...value,
              name: value.name,
              message: value.message,
              stack: value.stack,
              cause: value.cause,
            };
          }
        }
        return value;
      },
    );
    return message ? `${message} ${details}` : details;
  };
  return {
    debug: () => {},
    info: (record, message) => output.log(format(record, message)),
    warn: (record, message) => output.warn(format(record, message)),
    error: (record, message) => output.error(format(record, message)),
  };
}

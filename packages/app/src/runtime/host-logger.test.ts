import { expect, it } from "vitest";
import { createHostLogger } from "./host-logger";

it("preserves the original transport cause and tolerates a cyclic cause chain", () => {
  const lines: string[] = [];
  const capture = (...values: unknown[]) => lines.push(values.map(String).join(" "));
  const logger = createHostLogger(() => "test-host", {
    log: capture,
    warn: capture,
    error: capture,
  });
  const transport = new Error("socket closed");
  const wrapper = new Error("Subscription failed", { cause: transport });
  Object.defineProperty(transport, "cause", { value: wrapper });
  logger.error({ err: wrapper }, "subscription_error");
  const record = JSON.parse(lines[0]!.slice("subscription_error ".length));
  expect(record.err.cause.message).toBe("socket closed");
  expect(record.err.cause.stack).toBe(transport.stack);
  expect(record.err.cause.cause).toBe("[Circular]");
});

it("retains host and error details in the desktop's text-only console capture", () => {
  const lines: { level: string; text: string }[] = [];
  const capture =
    (level: string) =>
    (...values: unknown[]) => {
      lines.push({ level, text: values.map(String).join(" ") });
    };
  const logger = createHostLogger(() => "offline-host", {
    log: capture("info"),
    warn: capture("warn"),
    error: capture("error"),
  });
  logger.warn(
    { err: { name: "Error", message: "malformed ready envelope" } },
    "relay_e2ee_channel_error",
  );
  expect(lines).toEqual([
    {
      level: "warn",
      text: 'relay_e2ee_channel_error {"serverId":"offline-host","err":{"name":"Error","message":"malformed ready envelope"}}',
    },
  ]);
});

it("keeps native Error messages and severity without failing on circular diagnostics", () => {
  const lines: { level: string; text: string }[] = [];
  const capture =
    (level: string) =>
    (...values: unknown[]) => {
      lines.push({ level, text: values.map(String).join(" ") });
    };
  const logger = createHostLogger(() => "test-host", {
    log: capture("info"),
    warn: capture("warn"),
    error: capture("error"),
  });
  const record: { err: Error; self?: object } = { err: new Error("connection lost") };
  record.self = record;
  logger.error(record, "Connection failed");
  expect(lines[0]?.level).toBe("error");
  expect(lines[0]?.text).toContain('"message":"connection lost"');
  expect(lines[0]?.text).toContain('"serverId":"test-host"');
  expect(lines[0]?.text).toContain('"[Circular]"');
  logger.info({ status: "offline" }, "Host status");
  expect(lines[1]).toEqual({
    level: "info",
    text: 'Host status {"serverId":"test-host","status":"offline"}',
  });
  logger.debug({ status: "offline" }, "Host status");
  expect(lines).toHaveLength(2);
});

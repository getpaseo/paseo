import { describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { DesktopToolsBroker } from "./broker.js";
const deviceId = randomUUID();
const agentId = randomUUID();

describe("desktop control admission", () => {
  it("checks live Plan mode before dispatching an action", async () => {
    const send = vi.fn();
    const broker = new DesktopToolsBroker(() => ({ deviceId, observationOnly: true }));
    broker.registerHost("source", deviceId, send);
    await expect(
      broker.execute(agentId, { command: "click", x: 2, y: 3, button: "left" }),
    ).rejects.toThrow("Plan");
    expect(send).not.toHaveBeenCalled();
  });
  it("revokes unknown actions on disconnect and never replays them", async () => {
    const send = vi.fn();
    const broker = new DesktopToolsBroker(() => ({ deviceId, observationOnly: false }));
    const release = broker.registerHost("source", deviceId, send);
    const result = broker.execute(agentId, { command: "screenshot" });
    await vi.waitFor(() => expect(send).toHaveBeenCalled());
    release();
    await expect(result).rejects.toThrow();
    broker.registerHost("another-source", deviceId, send);
    await expect(broker.execute(agentId, { command: "screenshot" })).rejects.toThrow("revoked");
    expect(
      send.mock.calls.filter(([message]) => message.type === "desktop.control.execute.request"),
    ).toHaveLength(1);
  });
  it("accepts responses only from the admitted source and exact session", async () => {
    const send = vi.fn();
    const broker = new DesktopToolsBroker(() => ({ deviceId, observationOnly: false }));
    broker.registerHost("source", deviceId, send);
    const result = broker.execute(agentId, { command: "screenshot" });
    await vi.waitFor(() => expect(send).toHaveBeenCalled());
    const request = send.mock.calls[0][0];
    expect(
      broker.respond("intruder", {
        type: "desktop.control.execute.response",
        payload: {
          requestId: request.requestId,
          sessionId: request.sessionId,
          ok: true,
          result: {},
        },
      }),
    ).toBe(false);
    expect(
      broker.respond("source", {
        type: "desktop.control.execute.response",
        payload: {
          requestId: request.requestId,
          sessionId: request.sessionId,
          ok: true,
          result: { png: "a" },
        },
      }),
    ).toBe(true);
    await expect(result).resolves.toEqual({ png: "a" });
    broker.stop("source", deviceId);
  });
});

it("holds the controller across commands while another agent waits", async () => {
  const send = vi.fn();
  const broker = new DesktopToolsBroker(() => ({ deviceId, observationOnly: false }));
  broker.registerHost("source", deviceId, send);
  const first = broker.execute(agentId, { command: "accessibility" });
  await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
  const firstRequest = send.mock.calls[0][0];
  broker.respond("source", {
    type: "desktop.control.execute.response",
    payload: {
      requestId: firstRequest.requestId,
      sessionId: firstRequest.sessionId,
      ok: true,
      result: {},
    },
  });
  await first;
  const other = randomUUID();
  const waiting = broker.execute(other, { command: "accessibility" });
  await Promise.resolve();
  expect(send).toHaveBeenCalledTimes(1);
  broker.release(agentId);
  await vi.waitFor(() =>
    expect(send.mock.calls.some(([message]) => message.agentId === other)).toBe(true),
  );
  const next = send.mock.calls.find(([message]) => message.agentId === other)![0];
  broker.respond("source", {
    type: "desktop.control.execute.response",
    payload: { requestId: next.requestId, sessionId: next.sessionId, ok: true, result: {} },
  });
  await waiting;
  broker.release(other);
});

it("stop rejects both the in-flight command and waiting agents", async () => {
  const send = vi.fn();
  const broker = new DesktopToolsBroker(() => ({ deviceId, observationOnly: false }));
  broker.registerHost("source", deviceId, send);
  const first = broker.execute(agentId, { command: "accessibility" });
  const firstRejected = expect(first).rejects.toThrow("revoked");
  await vi.waitFor(() => expect(send).toHaveBeenCalled());
  const waiting = broker.execute(randomUUID(), { command: "accessibility" });
  const waitingRejected = expect(waiting).rejects.toThrow("revoked");
  broker.stop("source", deviceId);
  await Promise.all([firstRejected, waitingRejected]);
  expect(
    send.mock.calls.filter(([message]) => message.type === "desktop.control.execute.request"),
  ).toHaveLength(1);
});

it("a host cannot stop a different device's waiting agent", async () => {
  const secondDevice = randomUUID();
  const secondAgent = randomUUID();
  const send = vi.fn();
  const broker = new DesktopToolsBroker((id) => ({
    deviceId: id === secondAgent ? secondDevice : deviceId,
    observationOnly: false,
  }));
  broker.registerHost("source", deviceId, send);
  broker.registerHost("second-source", secondDevice, send);
  const first = broker.execute(agentId, { command: "accessibility" });
  await vi.waitFor(() => expect(send).toHaveBeenCalled());
  const one = send.mock.calls[0][0];
  broker.respond("source", {
    type: "desktop.control.execute.response",
    payload: { requestId: one.requestId, sessionId: one.sessionId, ok: true },
  });
  await first;
  const next = broker.execute(secondAgent, { command: "accessibility" });
  broker.stop("source", secondDevice);
  broker.release(agentId);
  await vi.waitFor(() =>
    expect(send.mock.calls.some(([message]) => message.agentId === secondAgent)).toBe(true),
  );
  const two = send.mock.calls.find(([message]) => message.agentId === secondAgent)![0];
  broker.respond("second-source", {
    type: "desktop.control.execute.response",
    payload: { requestId: two.requestId, sessionId: two.sessionId, ok: true, result: { ok: true } },
  });
  await expect(next).resolves.toEqual({ ok: true });
  broker.release(secondAgent);
});

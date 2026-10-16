import { AgentBusyError } from "../agent/busy-error.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { MessageReceipts } from "./index.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});
async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "agent-requests-"));
  directories.push(directory);
  return { directory, requests: new MessageReceipts(directory) };
}

test("message retries survive reconstruction without submitting twice", async () => {
  const { requests, directory } = await fixture();
  let deliveries = 0;
  const input = {
    agentId: "agent",
    messageId: "arrival",
    request: { text: "hello" },
    send: async () => {
      deliveries++;
    },
  };
  await Promise.all([requests.send(input), requests.send(input)]);
  await new MessageReceipts(directory).send(input);
  expect(deliveries).toBe(1);
  await requests.send({ ...input, agentId: "another" });
  expect(deliveries).toBe(2);
});

test("ambiguous provider delivery is never blindly replayed after restart", async () => {
  const { requests, directory } = await fixture();
  let deliveries = 0;
  const input = {
    agentId: "agent",
    messageId: "arrival",
    request: {},
    send: async () => {
      deliveries++;
      throw new Error("connection lost");
    },
  };
  await expect(requests.send(input)).rejects.toThrow("connection lost");
  await expect(new MessageReceipts(directory).send(input)).rejects.toThrow(
    "agent_request_outcome_unknown",
  );
  expect(deliveries).toBe(1);
});

test("failed local message preparation does not leave an ambiguous receipt", async () => {
  const { requests, directory } = await fixture();
  let available = false;
  let sends = 0;
  const input = {
    agentId: "agent",
    messageId: "message",
    request: {},
    prepare: async () => {
      if (!available) throw new Error("load failed");
    },
    send: async () => {
      sends++;
    },
  };
  await expect(requests.send(input)).rejects.toThrow("load failed");
  available = true;
  await new MessageReceipts(directory).send(input);
  available = false;
  await requests.send(input);
  expect(sends).toBe(1);
});

test("busy admission can retry the same receipt after the agent becomes idle", async () => {
  const { requests, directory } = await fixture();
  let busy = true;
  let deliveries = 0;
  const input = {
    agentId: "agent",
    messageId: "same",
    request: { text: "hello", activeTurnBehavior: "reject" },
    send: async () => {
      if (busy) throw new AgentBusyError("agent");
      deliveries++;
    },
  };
  await expect(requests.send(input)).rejects.toThrow("agent_busy");
  busy = false;
  await new MessageReceipts(directory).send(input);
  // A completed replay does not even reach admission, which may now be busy.
  busy = true;
  await requests.send(input);
  expect(deliveries).toBe(1);
});

test("a plain error named agent_busy is still ambiguous and cannot erase a receipt", async () => {
  const { requests, directory } = await fixture();
  const input = {
    agentId: "agent",
    messageId: "ambiguous",
    request: {},
    send: async () => {
      throw new Error("agent_busy");
    },
  };
  await expect(requests.send(input)).rejects.toThrow("agent_busy");
  await expect(new MessageReceipts(directory).send(input)).rejects.toThrow(
    "agent_request_outcome_unknown",
  );
});

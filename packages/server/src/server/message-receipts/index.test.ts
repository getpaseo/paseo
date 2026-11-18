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
    send: async (beforeDispatch: () => Promise<void>) => {
      await beforeDispatch();
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
    send: async (beforeDispatch: () => Promise<void>) => {
      await beforeDispatch();
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

test("a send that fails before beforeDispatch can be retried with the same message", async () => {
  const { requests, directory } = await fixture();
  let available = false;
  let sends = 0;
  const input = {
    agentId: "agent",
    messageId: "message",
    request: {},
    send: async (beforeDispatch: () => Promise<void>) => {
      if (!available) throw new Error("mode change failed");
      await beforeDispatch();
      sends++;
    },
  };
  await expect(requests.send(input)).rejects.toThrow("mode change failed");
  available = true;
  await new MessageReceipts(directory).send(input);
  available = false;
  await requests.send(input);
  expect(sends).toBe(1);
});

test("a message answered before delivery is saved until its dispatch", async () => {
  const { requests, directory } = await fixture();
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let accepted = false;
  const delivered = requests.send({
    agentId: "agent",
    messageId: "early",
    request: { text: "hello" },
    accept: {
      delivery: { text: "hello" },
      onAccepted: () => {
        accepted = true;
      },
    },
    send: async (beforeDispatch) => {
      await released;
      await beforeDispatch();
    },
  });
  await expect.poll(() => accepted).toBe(true);
  expect(await new MessageReceipts(directory).listAccepted()).toEqual([
    {
      agentId: "agent",
      messageId: "early",
      request: { text: "hello" },
      delivery: { text: "hello" },
    },
  ]);
  release();
  await delivered;
  expect(await new MessageReceipts(directory).listAccepted()).toEqual([]);
});

test("a saved message is delivered once by the next daemon", async () => {
  const { requests, directory } = await fixture();
  const input = {
    agentId: "agent",
    messageId: "saved",
    request: { text: "hello" },
  };
  await expect(
    requests.send({
      ...input,
      accept: { delivery: null, onAccepted: () => {} },
      keepAcceptedAfter: () => true,
      send: async () => {
        throw new Error("daemon stopping");
      },
    }),
  ).rejects.toThrow("daemon stopping");

  const next = new MessageReceipts(directory);
  const [saved] = await next.listAccepted();
  let deliveries = 0;
  const deliver = {
    ...input,
    request: saved!.request,
    send: async (beforeDispatch: () => Promise<void>) => {
      await beforeDispatch();
      deliveries++;
    },
  };
  await Promise.all([next.send(deliver), next.send(deliver)]);
  expect(deliveries).toBe(1);
  expect(await next.listAccepted()).toEqual([]);
});

test("a reported delivery failure drops the saved message", async () => {
  const { requests } = await fixture();
  await expect(
    requests.send({
      agentId: "agent",
      messageId: "failed",
      request: {},
      accept: { delivery: null, onAccepted: () => {} },
      send: async () => {
        throw new Error("load failed");
      },
    }),
  ).rejects.toThrow("load failed");
  expect(await requests.listAccepted()).toEqual([]);
});

test("waiting for accepted messages ends when their delivery settles", async () => {
  const { requests } = await fixture();
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let accepted = false;
  const delivered = requests.send({
    agentId: "agent",
    messageId: "waited",
    request: {},
    accept: {
      delivery: null,
      onAccepted: () => {
        accepted = true;
      },
    },
    send: async (beforeDispatch) => {
      await released;
      await beforeDispatch();
    },
  });
  // The sender waits after its answer, as `paseo send` does.
  await expect.poll(() => accepted).toBe(true);
  let waited = false;
  const waiting = (async () => {
    await requests.waitForAccepted("agent", new AbortController().signal);
    waited = true;
  })();
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(waited).toBe(false);
  release();
  await delivered;
  await waiting;
  expect(waited).toBe(true);
});

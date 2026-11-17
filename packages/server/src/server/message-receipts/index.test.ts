import { messageFingerprint } from "./fingerprint.js";
import { MessageAcceptanceStore } from "./acceptance.js";
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
  expect(await new MessageReceipts(directory).getStatus(input)).toMatchObject({
    status: "rejected",
    failure: { outcome: "not_submitted" },
  });
  available = true;
  await new MessageReceipts(directory).send(input);
  available = false;
  await requests.send(input);
  expect(sends).toBe(1);
});

for (const restart of [false, true]) {
  test(`durable acceptance evidence settles an ambiguous receipt (restart: ${restart})`, async () => {
    const { requests, directory } = await fixture();
    const acceptancePath = path.join(directory, "acceptance");
    const identity = { agentId: "agent", clientMessageId: "arrival", prompt: "hello" };
    let sends = 0;
    const input = {
      agentId: "agent",
      messageId: "arrival",
      request: { prompt: "hello" },
      isAccepted: () => new MessageAcceptanceStore(acceptancePath).has(identity),
      send: async (beforeDispatch: () => Promise<void>) => {
        await beforeDispatch();
        sends++;
        throw new Error("acknowledgement lost");
      },
    };
    await expect(requests.send(input)).rejects.toThrow("acknowledgement lost");
    await new MessageAcceptanceStore(acceptancePath).record({
      agentId: identity.agentId,
      clientMessageId: identity.clientMessageId,
      promptFingerprint: messageFingerprint(identity.prompt),
    });
    const receipts = restart ? new MessageReceipts(directory) : requests;
    await receipts.send(input);
    await new MessageReceipts(directory).send(input);
    expect(sends).toBe(1);
  });
}

test("delivery failure reconciles a provider acknowledgement immediately", async () => {
  const { requests, directory } = await fixture();
  const acceptance = new MessageAcceptanceStore(path.join(directory, "acceptance"));
  const identity = { agentId: "agent", clientMessageId: "arrival", prompt: "hello" };
  let sends = 0;
  const input = {
    agentId: "agent",
    messageId: "arrival",
    request: { prompt: "hello" },
    isAccepted: () => acceptance.has(identity),
    send: async (beforeDispatch: () => Promise<void>) => {
      await beforeDispatch();
      sends++;
      await acceptance.record({
        agentId: identity.agentId,
        clientMessageId: identity.clientMessageId,
        promptFingerprint: messageFingerprint(identity.prompt),
      });
      throw new Error("acknowledgement lost");
    },
  };
  await requests.send(input);
  await requests.send(input);
  expect(sends).toBe(1);
});

test("acceptance records survive reconstruction and bind agent, message and full prompt", async () => {
  const { directory } = await fixture();
  const identity = {
    agentId: "agent",
    clientMessageId: "message",
    prompt: [{ type: "text" as const, text: "hello" }],
  };
  await new MessageAcceptanceStore(path.join(directory, "acceptance")).record({
    agentId: identity.agentId,
    clientMessageId: identity.clientMessageId,
    promptFingerprint: messageFingerprint(identity.prompt),
  });
  const restored = new MessageAcceptanceStore(path.join(directory, "acceptance"));
  await expect(restored.has(identity)).resolves.toBe(true);
  await expect(restored.has({ ...identity, agentId: "other" })).resolves.toBe(false);
  await expect(restored.has({ ...identity, clientMessageId: "other" })).resolves.toBe(false);
  await expect(restored.has({ ...identity, prompt: "hello" })).resolves.toBe(false);
  await expect(
    restored.has({ ...identity, prompt: [{ type: "text", text: "changed" }] }),
  ).resolves.toBe(false);
});

test("legacy pending receipts without durable acceptance remain unknown after restart", async () => {
  const { directory, requests } = await fixture();
  const acceptance = new MessageAcceptanceStore(path.join(directory, "acceptance"));
  let sends = 0;
  const input = {
    agentId: "legacy",
    messageId: "old-message",
    request: { prompt: "hello" },
    isAccepted: () =>
      acceptance.has({ agentId: "legacy", clientMessageId: "old-message", prompt: "hello" }),
    send: async (beforeDispatch: () => Promise<void>) => {
      await beforeDispatch();
      sends++;
      throw new Error("lost acknowledgement");
    },
  };
  await expect(requests.send(input)).rejects.toThrow("lost acknowledgement");
  await expect(new MessageReceipts(directory).send(input)).rejects.toThrow(
    "agent_request_outcome_unknown",
  );
  expect(sends).toBe(1);
});

test("positive acceptance cannot override a conflicting retry payload", async () => {
  const { directory, requests } = await fixture();
  let sends = 0;
  const input = {
    agentId: "agent",
    messageId: "arrival",
    request: { text: "original" },
    send: async (beforeDispatch: () => Promise<void>) => {
      await beforeDispatch();
      sends++;
      throw new Error("lost response");
    },
  };
  await expect(requests.send(input)).rejects.toThrow("lost response");
  await expect(
    new MessageReceipts(directory).send({
      ...input,
      request: { text: "changed" },
      isAccepted: async () => true,
    }),
  ).rejects.toThrow("agent_request_key_conflict");
  expect(sends).toBe(1);
});

test("a definitive rejection permits a same-ID retry after restart", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "receipt-outcomes-"));
  try {
    const receipts = new MessageReceipts(directory);
    let sends = 0;
    const identity = { agentId: "agent", messageId: "stable", request: { prompt: "hello" } };
    await expect(
      receipts.send({
        ...identity,
        send: async (beforeDispatch) => {
          await beforeDispatch();
          sends += 1;
          throw Object.assign(new Error("Provider refused"), { deliveryOutcome: "rejected" });
        },
      }),
    ).rejects.toThrow("Provider refused");
    await expect(
      new MessageReceipts(directory).send({
        ...identity,
        send: async (beforeDispatch) => {
          await beforeDispatch();
          sends += 1;
        },
      }),
    ).resolves.toBeUndefined();
    expect(sends).toBe(2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("delivery status observes in-flight work and durable acceptance without resending", async () => {
  const { requests, directory } = await fixture();
  let release!: () => void;
  let dispatched!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const entered = new Promise<void>((resolve) => {
    dispatched = resolve;
  });
  const identity = { agentId: "agent", messageId: "slow", request: { prompt: "hello" } };
  let sends = 0;
  const send = requests.send({
    ...identity,
    send: async (beforeDispatch) => {
      await beforeDispatch();
      sends += 1;
      dispatched();
      await gate;
    },
  });
  try {
    await entered;
    await expect(requests.getStatus(identity)).resolves.toEqual({ status: "in_flight" });
    release();
    await send;
    await expect(new MessageReceipts(directory).getStatus(identity)).resolves.toEqual({
      status: "accepted",
    });
    expect(sends).toBe(1);
    await expect(
      requests.getStatus({ ...identity, request: { prompt: "different" } }),
    ).rejects.toThrow("agent_request_key_conflict");
  } finally {
    release();
    await send;
  }
});

test("a pending receipt without positive evidence remains unknown and is never resent", async () => {
  const { requests, directory } = await fixture();
  const identity = { agentId: "agent", messageId: "uncertain", request: { prompt: "hello" } };
  let sends = 0;
  const send = async (beforeDispatch: () => Promise<void>) => {
    await beforeDispatch();
    sends += 1;
    throw new Error("connection lost after submission");
  };
  await expect(requests.send({ ...identity, send })).rejects.toMatchObject({
    deliveryOutcome: "unknown",
  });
  const restored = new MessageReceipts(directory);
  await expect(restored.getStatus(identity)).resolves.toEqual({ status: "unknown" });
  await expect(restored.getStatus({ ...identity, isAccepted: async () => true })).resolves.toEqual({
    status: "accepted",
  });
  await expect(restored.send({ ...identity, send })).rejects.toMatchObject({
    deliveryOutcome: "unknown",
  });
  await expect(restored.getStatus({ ...identity, messageId: "legacy-missing" })).resolves.toEqual({
    status: "unknown",
  });
  expect(sends).toBe(1);
});

test("completed receipts retire acceptance journals and agent cleanup preserves other agents", async () => {
  const { requests, directory } = await fixture();
  const acceptance = new MessageAcceptanceStore(path.join(directory, "acceptance"));
  const identity = { agentId: "agent", clientMessageId: "stable", prompt: "hello" };
  const other = { ...identity, agentId: "other" };
  for (const item of [identity, other])
    await acceptance.record({
      agentId: item.agentId,
      clientMessageId: item.clientMessageId,
      promptFingerprint: messageFingerprint(item.prompt),
    });
  await requests.send({
    agentId: identity.agentId,
    messageId: identity.clientMessageId,
    request: { prompt: identity.prompt },
    send: async (beforeDispatch) => {
      await beforeDispatch();
    },
    onCompleted: () => acceptance.forget(identity),
  });
  await expect(acceptance.has(identity)).resolves.toBe(false);
  await expect(
    requests.getStatus({
      agentId: identity.agentId,
      messageId: identity.clientMessageId,
      request: { prompt: identity.prompt },
    }),
  ).resolves.toEqual({ status: "accepted" });
  await acceptance.forgetAgent("agent");
  await expect(acceptance.has(other)).resolves.toBe(true);
  await acceptance.forgetAgent("other");
  await expect(acceptance.has(other)).resolves.toBe(false);
});

test("status stays accepted when its journal is replaced by a completed receipt during the check", async () => {
  const { requests } = await fixture();
  const identity = { agentId: "agent", messageId: "racing-commit", request: { prompt: "hello" } };
  await expect(
    requests.send({
      ...identity,
      send: async (beforeDispatch) => {
        await beforeDispatch();
        throw new Error("reply lost");
      },
    }),
  ).rejects.toThrow("reply lost");
  await expect(
    requests.getStatus({
      ...identity,
      isAccepted: async () => {
        await requests.send({
          ...identity,
          isAccepted: async () => true,
          send: async () => {
            throw new Error("must not resend");
          },
        });
        return false;
      },
    }),
  ).resolves.toEqual({ status: "accepted" });
});

test("rechecks payload identity when a receipt appears during a status read", async () => {
  const { requests } = await fixture();
  const identity = { agentId: "agent", messageId: "racing", request: { text: "Never sent" } };
  await expect(
    requests.getStatus({
      ...identity,
      isAccepted: async () => {
        await requests.send({
          ...identity,
          request: { text: "Actually sent" },
          send: async (before) => {
            await before();
          },
        });
        return false;
      },
    }),
  ).rejects.toThrow("agent_request_key_conflict");
});

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { MessageReceipts, AgentRequestRejectedError } from "./index.js";

import { AgentTurnNotAcceptedError } from "../agent/agent-sdk-types.js";

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

test("a final admission refusal replays after concurrency and journal reconstruction without another callback", async () => {
  const { requests, directory } = await fixture();
  let admissions = 0;
  const input = {
    agentId: "planner",
    messageId: "revision",
    request: { plan: "source" },
    send: async () => {
      admissions++;
      throw new AgentRequestRejectedError();
    },
  };
  const results = await Promise.allSettled([requests.send(input), requests.send(input)]);
  expect(
    results.every(
      (result) =>
        result.status === "rejected" && result.reason instanceof AgentRequestRejectedError,
    ),
  ).toBe(true);
  await expect(new MessageReceipts(directory).send(input)).rejects.toBeInstanceOf(
    AgentRequestRejectedError,
  );
  expect(admissions).toBe(1);
});

test("definitive non-acceptance permits the same message after journal reconstruction", async () => {
  const { requests, directory } = await fixture();
  let reject = true;
  const delivered: string[] = [];
  const input = {
    agentId: "agent",
    messageId: "review-prompt",
    request: { text: "Review the plan" },
    send: async () => {
      if (reject) throw new AgentTurnNotAcceptedError("Prompt rejected");
      delivered.push("Review the plan");
    },
  };
  await expect(requests.send(input)).rejects.toThrow("agent_request_not_accepted");
  reject = false;
  await new MessageReceipts(directory).send(input);
  await requests.send(input);
  expect(delivered).toEqual(["Review the plan"]);
});

import { readFileSync } from "node:fs";
import pino from "pino";
import { expect } from "vitest";
import type { AgentStreamEvent } from "../../../agent-sdk-types.js";
import { PiRpcAgentClient } from "../agent.js";
import { PiHistoryMapper } from "../history-mapper.js";
import type { PiAgentMessage, PiAgentSessionEvent } from "../rpc-types.js";
import { FakePi } from "../test-utils/fake-pi.js";

interface Fixture {
  provenance: {
    package: string;
    version: string;
    sourceCommit: string;
    piVersion: string;
    captureDate: string;
  };
  events: PiAgentSessionEvent[];
  messages: PiAgentMessage[];
}

export function readSubagentFixture(
  path: URL,
  replaceSessionFile?: { from: string; to: string },
): Fixture {
  let source = readFileSync(path, "utf8");
  if (replaceSessionFile)
    source = source.replaceAll(replaceSessionFile.from, replaceSessionFile.to);
  const fixture = JSON.parse(source) as Fixture;
  expect(fixture.provenance).toEqual({
    package: expect.any(String),
    version: expect.any(String),
    sourceCommit: expect.any(String),
    piVersion: expect.any(String),
    captureDate: expect.any(String),
  });
  return fixture;
}

export async function verifySubagentFixture(
  fixture: Fixture,
): Promise<Extract<AgentStreamEvent, { type: "provider_subagent" }>[]> {
  const pi = new FakePi();
  const client = new PiRpcAgentClient({ logger: pino({ level: "silent" }), runtime: pi });
  const session = await client.createSession({
    provider: "pi",
    cwd: "/tmp/paseo-pi-subagent-fixture",
  });
  const live: AgentStreamEvent[] = [];
  session.subscribe((event) => live.push(event));
  try {
    await session.startTurn("Delegate work");
    for (const event of fixture.events) pi.latestSession().emit(event);
    pi.latestSession().finishTurn();
    const replay = new PiHistoryMapper("pi").mapMessages(fixture.messages);
    const liveSubagents = live.filter((event) => event.type === "provider_subagent");
    const replaySubagents = replay.filter((event) => event.type === "provider_subagent");
    expect(liveSubagents).toEqual(replaySubagents);
    return liveSubagents;
  } finally {
    await session.close();
  }
}

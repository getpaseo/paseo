import { beforeEach, describe, expect, it } from "vitest";

import {
  forgetAgentStreamActivity,
  readAgentStreamActivityAt,
  recordAgentStreamActivity,
} from "./stream-activity";

const SERVER_A = "host-a";
const SERVER_B = "host-b";
const AGENT = "agent-1";

beforeEach(() => {
  forgetAgentStreamActivity(SERVER_A, AGENT);
  forgetAgentStreamActivity(SERVER_B, AGENT);
});

describe("stream activity tracker", () => {
  it("reads back nothing for an agent that has never streamed", () => {
    expect(readAgentStreamActivityAt(SERVER_A, AGENT)).toBeUndefined();
  });

  it("records and reads back the observed instant", () => {
    recordAgentStreamActivity(SERVER_A, AGENT, 1_000);

    expect(readAgentStreamActivityAt(SERVER_A, AGENT)).toBe(1_000);
  });

  it("keys entries per server, so the same agent id on two hosts stays separate", () => {
    recordAgentStreamActivity(SERVER_A, AGENT, 1_000);
    recordAgentStreamActivity(SERVER_B, AGENT, 5_000);

    expect(readAgentStreamActivityAt(SERVER_A, AGENT)).toBe(1_000);
    expect(readAgentStreamActivityAt(SERVER_B, AGENT)).toBe(5_000);
  });

  it("advances to the newer instant", () => {
    recordAgentStreamActivity(SERVER_A, AGENT, 1_000);
    recordAgentStreamActivity(SERVER_A, AGENT, 2_000);

    expect(readAgentStreamActivityAt(SERVER_A, AGENT)).toBe(2_000);
  });

  it("never moves backwards", () => {
    // A clock that steps back — a laptop waking, an NTP correction — must not make a live
    // agent read as more idle than it is.
    recordAgentStreamActivity(SERVER_A, AGENT, 2_000);
    recordAgentStreamActivity(SERVER_A, AGENT, 1_000);

    expect(readAgentStreamActivityAt(SERVER_A, AGENT)).toBe(2_000);
  });

  it("forgets an agent so entries cannot leak after deletion", () => {
    recordAgentStreamActivity(SERVER_A, AGENT, 1_000);
    forgetAgentStreamActivity(SERVER_A, AGENT);

    expect(readAgentStreamActivityAt(SERVER_A, AGENT)).toBeUndefined();
  });

  it("forgets only the requested server's entry", () => {
    recordAgentStreamActivity(SERVER_A, AGENT, 1_000);
    recordAgentStreamActivity(SERVER_B, AGENT, 5_000);

    forgetAgentStreamActivity(SERVER_A, AGENT);

    expect(readAgentStreamActivityAt(SERVER_A, AGENT)).toBeUndefined();
    expect(readAgentStreamActivityAt(SERVER_B, AGENT)).toBe(5_000);
  });
});

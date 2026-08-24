import { describe, expect, test } from "vitest";

import { parseToolArgs } from "./tool-call-detail.js";
import { resolveOmpEmittedToolCallId } from "./tool-call-id.js";

describe("OMP tool call ids", () => {
  test("uses stable synthetic ids only for subagent poll calls", () => {
    expect(
      resolveOmpEmittedToolCallId(
        "poll-1",
        parseToolArgs("subagent", { poll: ["job-b", "job-a"] }),
      ),
    ).toBe("omp-poll:job-a,job-b");
    expect(
      resolveOmpEmittedToolCallId(
        "poll-2",
        parseToolArgs("subagent", { poll: ["job-a", "job-b"] }),
      ),
    ).toBe("omp-poll:job-a,job-b");
    expect(
      resolveOmpEmittedToolCallId("poll-3", parseToolArgs("subagent", { poll: ["job-a"] })),
    ).toBe("omp-poll:job-a");
    expect(
      resolveOmpEmittedToolCallId(
        "spawn-1",
        parseToolArgs("subagent", { spawn: [{ prompt: "go" }] }),
      ),
    ).toBe("spawn-1");
    expect(
      resolveOmpEmittedToolCallId("bash-1", parseToolArgs("bash", { command: "echo hi" })),
    ).toBe("bash-1");
  });
});

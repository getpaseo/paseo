import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createTestLogger } from "../../test-utils/test-logger.js";
import { writeJsonFileAtomic } from "../atomic-file.js";
import { FileAgentTimelineStore } from "./file-agent-timeline-store.js";
import type { AgentTimelineRow } from "./agent-timeline-store-types.js";

const logger = createTestLogger();
const temporaryDirectories: string[] = [];

async function createStoreDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "file-agent-timeline-store-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("FileAgentTimelineStore", () => {
  it("keeps the prior complete timeline after a failed replacement and exposes one replacement after restart", async () => {
    const directory = await createStoreDirectory();
    const agentId = "agent-with-atomic-history";
    let rejectWrites = false;
    const store = new FileAgentTimelineStore(directory, logger, {
      epochFactory: () => "replacement-epoch",
      writeJson: async (filePath, value) => {
        if (rejectWrites) {
          throw new Error("injected pre-rename failure");
        }
        await writeJsonFileAtomic(filePath, value);
      },
    });
    const priorRows: AgentTimelineRow[] = [
      {
        seq: 1,
        timestamp: "2026-01-01T00:00:00.000Z",
        item: { type: "user_message", text: "prior complete timeline" },
      },
    ];
    const replacementRows: AgentTimelineRow[] = [
      {
        seq: 1,
        timestamp: "2026-02-01T00:00:00.000Z",
        item: { type: "user_message", text: "replacement row one" },
      },
      {
        seq: 2,
        timestamp: "2026-02-01T00:00:01.000Z",
        item: { type: "assistant_message", text: "replacement row two" },
      },
    ];

    await store.bulkInsert(agentId, priorRows);
    rejectWrites = true;
    await expect(store.replaceCommitted(agentId, replacementRows)).rejects.toThrow(
      "injected pre-rename failure",
    );

    const restartedAfterFailure = new FileAgentTimelineStore(directory, logger);
    await expect(restartedAfterFailure.getCommittedRows(agentId)).resolves.toEqual(priorRows);

    rejectWrites = false;
    await store.replaceCommitted(agentId, replacementRows);

    const restartedAfterSuccess = new FileAgentTimelineStore(directory, logger);
    await expect(restartedAfterSuccess.getCommittedRows(agentId)).resolves.toEqual(replacementRows);
    await expect(
      restartedAfterSuccess.fetchCommitted(agentId, { limit: 0 }),
    ).resolves.toMatchObject({
      epoch: "replacement-epoch",
      reset: false,
      staleCursor: false,
      gap: false,
      window: { minSeq: 1, maxSeq: 2, nextSeq: 3 },
      rows: replacementRows,
    });
  });
});

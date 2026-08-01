import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SessionOutboundMessage } from "../messages.js";
import { UiStateSession } from "./session.js";
import { UiStateStore } from "./store.js";

describe("UiStateSession", () => {
  let home: string;
  let store: UiStateStore;
  let emitted: SessionOutboundMessage[];
  let broadcasted: SessionOutboundMessage[];
  let session: UiStateSession;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "paseo-ui-state-session-"));
    store = new UiStateStore(home);
    emitted = [];
    broadcasted = [];
    session = new UiStateSession({
      host: {
        emit: (message) => {
          emitted.push(message);
        },
        broadcast: (message) => {
          broadcasted.push(message);
        },
      },
      store,
    });
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it("get missing returns null record", async () => {
    await session.handleGet({
      type: "ui_state.get.request",
      requestId: "r1",
      namespace: "composer",
      key: "agent:missing",
    });
    expect(emitted).toEqual([
      {
        type: "ui_state.get.response",
        payload: {
          requestId: "r1",
          namespace: "composer",
          key: "agent:missing",
          record: null,
          error: null,
        },
      },
    ]);
    expect(broadcasted).toEqual([]);
  });

  it("upsert then get returns record and broadcasts update", async () => {
    await session.handleUpsert({
      type: "ui_state.upsert.request",
      requestId: "r2",
      namespace: "composer",
      key: "agent:agt_1",
      record: { text: "hello", updatedAt: "2026-08-01T00:00:00.000Z" },
    });
    expect(emitted[0]).toMatchObject({
      type: "ui_state.upsert.response",
      payload: { applied: true, error: null },
    });
    expect(broadcasted).toEqual([
      {
        type: "ui_state.updated",
        namespace: "composer",
        key: "agent:agt_1",
        record: { text: "hello", updatedAt: "2026-08-01T00:00:00.000Z" },
        updatedAt: "2026-08-01T00:00:00.000Z",
      },
    ]);

    emitted = [];
    await session.handleGet({
      type: "ui_state.get.request",
      requestId: "r3",
      namespace: "composer",
      key: "agent:agt_1",
    });
    expect(emitted[0]).toMatchObject({
      type: "ui_state.get.response",
      payload: {
        record: { text: "hello", updatedAt: "2026-08-01T00:00:00.000Z" },
        error: null,
      },
    });
  });

  it("older upsert is not applied and does not broadcast", async () => {
    await session.handleUpsert({
      type: "ui_state.upsert.request",
      requestId: "r4",
      namespace: "composer",
      key: "agent:agt_1",
      record: { text: "new", updatedAt: "2026-08-01T01:00:00.000Z" },
    });
    broadcasted = [];
    emitted = [];
    await session.handleUpsert({
      type: "ui_state.upsert.request",
      requestId: "r5",
      namespace: "composer",
      key: "agent:agt_1",
      record: { text: "old", updatedAt: "2026-08-01T00:00:00.000Z" },
    });
    expect(emitted[0]).toMatchObject({
      type: "ui_state.upsert.response",
      payload: { applied: false },
    });
    expect(broadcasted).toEqual([]);
  });

  it("clear removes and broadcasts null record", async () => {
    await session.handleUpsert({
      type: "ui_state.upsert.request",
      requestId: "r6",
      namespace: "composer",
      key: "agent:agt_1",
      record: { text: "bye", updatedAt: "2026-08-01T00:00:00.000Z" },
    });
    broadcasted = [];
    emitted = [];
    await session.handleClear({
      type: "ui_state.clear.request",
      requestId: "r7",
      namespace: "composer",
      key: "agent:agt_1",
      updatedAt: "2026-08-01T00:00:01.000Z",
    });
    expect(emitted[0]).toMatchObject({
      type: "ui_state.clear.response",
      payload: { applied: true, error: null },
    });
    expect(broadcasted).toEqual([
      {
        type: "ui_state.updated",
        namespace: "composer",
        key: "agent:agt_1",
        record: null,
        updatedAt: "2026-08-01T00:00:01.000Z",
      },
    ]);
  });
});

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sanitizeUiStateKey } from "./keys.js";
import { UiStateStore } from "./store.js";

describe("sanitizeUiStateKey", () => {
  it("rejects empty keys", () => {
    expect(() => sanitizeUiStateKey("")).toThrow(/empty/);
    expect(() => sanitizeUiStateKey("   ")).toThrow(/empty/);
  });

  it("replaces path separators", () => {
    expect(sanitizeUiStateKey("a/b\\c")).toBe("a_b_c");
  });

  it("replaces Windows-reserved filename characters", () => {
    expect(sanitizeUiStateKey("agent:agt_1")).toBe("agent_agt_1");
    expect(sanitizeUiStateKey("review:workspace=ws1:mode=working")).toBe(
      "review_workspace=ws1_mode=working",
    );
    expect(sanitizeUiStateKey('a*b?c"d<e>f|g')).toBe("a_b_c_d_e_f_g");
  });
});

describe("UiStateStore", () => {
  let home: string;
  let store: UiStateStore;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "paseo-ui-state-"));
    store = new UiStateStore(home);
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it("upserts and gets composer text", async () => {
    await store.upsert({
      namespace: "composer",
      key: "agent:agt_1",
      record: { text: "hello", updatedAt: "2026-08-01T00:00:00.000Z" },
    });
    const got = await store.get({ namespace: "composer", key: "agent:agt_1" });
    expect(got).toMatchObject({ text: "hello" });
  });

  it("returns null for missing keys", async () => {
    expect(await store.get({ namespace: "composer", key: "agent:missing" })).toBeNull();
  });

  it("LWW rejects older upsert", async () => {
    await store.upsert({
      namespace: "composer",
      key: "agent:agt_1",
      record: { text: "new", updatedAt: "2026-08-01T01:00:00.000Z" },
    });
    const result = await store.upsert({
      namespace: "composer",
      key: "agent:agt_1",
      record: { text: "old", updatedAt: "2026-08-01T00:00:00.000Z" },
    });
    expect(result.applied).toBe(false);
    expect((await store.get({ namespace: "composer", key: "agent:agt_1" }))?.text).toBe("new");
  });

  it("accepts newer upsert", async () => {
    await store.upsert({
      namespace: "composer",
      key: "agent:agt_1",
      record: { text: "old", updatedAt: "2026-08-01T00:00:00.000Z" },
    });
    const result = await store.upsert({
      namespace: "composer",
      key: "agent:agt_1",
      record: { text: "new", updatedAt: "2026-08-01T01:00:00.000Z" },
    });
    expect(result.applied).toBe(true);
    expect((await store.get({ namespace: "composer", key: "agent:agt_1" }))?.text).toBe("new");
  });

  it("clear removes record", async () => {
    const key = "review:workspace=ws1:mode=working:base=main:ignoreWhitespace=false";
    await store.upsert({
      namespace: "review",
      key,
      record: {
        comments: [],
        updatedAt: "2026-08-01T00:00:00.000Z",
      },
    });
    await store.clear({
      namespace: "review",
      key,
      updatedAt: "2026-08-01T00:00:01.000Z",
    });
    expect(await store.get({ namespace: "review", key })).toBeNull();
  });

  it("clear with older timestamp does not remove", async () => {
    await store.upsert({
      namespace: "composer",
      key: "agent:agt_1",
      record: { text: "keep", updatedAt: "2026-08-01T02:00:00.000Z" },
    });
    const result = await store.clear({
      namespace: "composer",
      key: "agent:agt_1",
      updatedAt: "2026-08-01T01:00:00.000Z",
    });
    expect(result.applied).toBe(false);
    expect((await store.get({ namespace: "composer", key: "agent:agt_1" }))?.text).toBe("keep");
  });

  it("lists entries filtered by keyPrefix", async () => {
    await store.upsert({
      namespace: "composer",
      key: "agent:a",
      record: { text: "a", updatedAt: "2026-08-01T00:00:00.000Z" },
    });
    await store.upsert({
      namespace: "composer",
      key: "agent:b",
      record: { text: "b", updatedAt: "2026-08-01T00:00:00.000Z" },
    });
    await store.upsert({
      namespace: "composer",
      key: "draft:x",
      record: { text: "x", updatedAt: "2026-08-01T00:00:00.000Z" },
    });
    const agents = await store.list({ namespace: "composer", keyPrefix: "agent:" });
    expect(agents.map((entry) => entry.key)).toEqual(["agent:a", "agent:b"]);
  });

  it("stores review comments", async () => {
    const key = "review:workspace=ws1:mode=working:base=main:ignoreWhitespace=false";
    await store.upsert({
      namespace: "review",
      key,
      record: {
        comments: [
          {
            id: "c1",
            filePath: "src/a.ts",
            side: "new",
            lineNumber: 3,
            body: "fix me",
            createdAt: "2026-08-01T00:00:00.000Z",
            updatedAt: "2026-08-01T00:00:00.000Z",
          },
        ],
        updatedAt: "2026-08-01T00:00:00.000Z",
      },
    });
    const got = await store.get({ namespace: "review", key });
    expect(got?.comments?.[0]?.body).toBe("fix me");
  });
});

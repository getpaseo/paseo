import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { createTestLogger } from "../../../test-utils/test-logger.js";
import {
  SHARED_CONTEXT_DIGEST_MAX_CHARS,
  SHARED_CONTEXT_MAX_BODY_LENGTH,
  SHARED_CONTEXT_MAX_ENTRIES_PER_PROJECT,
  SHARED_CONTEXT_MAX_TITLE_LENGTH,
  SharedContextLimitError,
  SharedContextStore,
} from "./store.js";

const cleanupPaths: string[] = [];

afterEach(() => {
  for (const target of cleanupPaths.splice(0)) {
    rmSync(target, { recursive: true, force: true });
  }
});

function createStore() {
  const paseoHome = mkdtempSync(join(tmpdir(), "shared-context-test-"));
  cleanupPaths.push(paseoHome);
  return { paseoHome, store: new SharedContextStore({ paseoHome, logger: createTestLogger() }) };
}

describe("SharedContextStore", () => {
  test("saves and lists entries per project", async () => {
    const { store } = createStore();
    const first = await store.save("prj_aaaa", {
      kind: "research",
      title: "Auth flow",
      body: "OAuth2 with PKCE; refresh tokens live in the session store.",
    });
    await store.save("prj_aaaa", {
      kind: "preference",
      title: "Commit style",
      body: "Conventional commits, no emojis.",
    });
    await store.save("prj_bbbb", {
      kind: "note",
      title: "Other project",
      body: "Should stay separate.",
    });

    const entries = await store.list("prj_aaaa");
    expect(entries).toHaveLength(2);
    expect(entries.map((entry) => entry.title)).toEqual(["Auth flow", "Commit style"]);
    expect(first.kind).toBe("research");
    expect(first.id).toMatch(/^ctx_[0-9a-f]{16}$/);
    expect(first.authorAgentId).toBeNull();
  });

  test("reads entries by id and returns empty for unknown ids", async () => {
    const { store } = createStore();
    const saved = await store.save("prj_aaaa", {
      kind: "learning",
      title: "Tests",
      body: "Vitest, run per-workspace.",
    });
    expect(await store.get("prj_aaaa", [saved.id])).toEqual([saved]);
    expect(await store.get("prj_aaaa", ["ctx_missing"])).toEqual([]);
    expect(await store.list("prj_unknown")).toEqual([]);
  });

  test("persists entries under the paseo home and reloads them", async () => {
    const { paseoHome, store } = createStore();
    await store.save("prj_aaaa", { kind: "note", title: "T", body: "B" });
    const raw = JSON.parse(
      readFileSync(join(paseoHome, "projects", "prj_aaaa", "shared-context.json"), "utf8"),
    );
    expect(raw.version).toBe(1);
    expect(raw.entries).toHaveLength(1);

    const reloaded = new SharedContextStore({ paseoHome, logger: createTestLogger() });
    expect(await reloaded.list("prj_aaaa")).toHaveLength(1);
  });

  test("rejects invalid ids, empty fields, and oversized entries", async () => {
    const { store } = createStore();
    await expect(store.save("bad/id", { kind: "note", title: "T", body: "B" })).rejects.toThrow(
      /Invalid project id/,
    );
    await expect(store.save("prj_aaaa", { kind: "note", title: "  ", body: "B" })).rejects.toThrow(
      "title is required",
    );
    await expect(
      store.save("prj_aaaa", {
        kind: "note",
        title: "T".repeat(SHARED_CONTEXT_MAX_TITLE_LENGTH + 1),
        body: "B",
      }),
    ).rejects.toThrow(SharedContextLimitError);
    await expect(
      store.save("prj_aaaa", {
        kind: "note",
        title: "T",
        body: "B".repeat(SHARED_CONTEXT_MAX_BODY_LENGTH + 1),
      }),
    ).rejects.toThrow(SharedContextLimitError);
  });

  test("enforces the per-project entry cap", async () => {
    const { store } = createStore();
    for (let i = 0; i < SHARED_CONTEXT_MAX_ENTRIES_PER_PROJECT; i += 1) {
      await store.save("prj_aaaa", { kind: "note", title: `T${i}`, body: "B" });
    }
    await expect(
      store.save("prj_aaaa", { kind: "note", title: "Over", body: "B" }),
    ).rejects.toThrow(SharedContextLimitError);
  });

  test("concurrent saves for one project are all kept", async () => {
    const { store } = createStore();
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        store.save("prj_aaaa", {
          kind: "note",
          title: `T${i}`,
          body: "B",
          authorAgentId: `agent-${i}`,
        }),
      ),
    );
    expect(await store.list("prj_aaaa")).toHaveLength(20);
  });

  test("treats a corrupt context file as empty instead of failing", async () => {
    const { paseoHome, store } = createStore();
    const filePath = join(paseoHome, "projects", "prj_aaaa", "shared-context.json");
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, "{not json", "utf8");
    expect(await store.list("prj_aaaa")).toEqual([]);
    const saved = await store.save("prj_aaaa", { kind: "note", title: "T", body: "B" });
    expect(await store.list("prj_aaaa")).toEqual([saved]);
  });

  test("renderDigest returns null without entries", async () => {
    const { store } = createStore();
    expect(await store.renderDigest("prj_aaaa")).toBeNull();
  });

  test("renderDigest renders newest first with provenance header", async () => {
    const { store } = createStore();
    await store.save("prj_aaaa", {
      kind: "learning",
      title: "Old learning",
      body: "First.",
      authorAgentId: "agent-1",
      authorLabel: "Repo scout",
    });
    await store.save("prj_aaaa", {
      kind: "preference",
      title: "New preference",
      body: "Second.",
      authorAgentId: "agent-2",
      authorLabel: null,
    });

    const digest = await store.renderDigest("prj_aaaa");
    expect(digest).toContain("<shared-project-context>");
    expect(digest).toContain("</shared-project-context>");
    expect(digest).toContain("context_save");
    expect(digest?.indexOf("New preference")).toBeLessThan(digest?.indexOf("Old learning") ?? -1);
    expect(digest).toContain("(Repo scout,");
    expect(digest).toContain("(agent,");
  });

  test("renderDigest caps total size and reports omitted entries", async () => {
    const { store } = createStore();
    const body = "B".repeat(500);
    for (let i = 0; i < 40; i += 1) {
      await store.save("prj_aaaa", { kind: "note", title: `T${i}`, body });
    }
    const digest = await store.renderDigest("prj_aaaa");
    expect(digest).not.toBeNull();
    expect(digest!.length).toBeLessThanOrEqual(SHARED_CONTEXT_DIGEST_MAX_CHARS + 300);
    expect(digest).toMatch(/\(\d+ older entries omitted/);
    expect(digest).toContain("T39");
    expect(digest).not.toContain("T0\n");
  });
});

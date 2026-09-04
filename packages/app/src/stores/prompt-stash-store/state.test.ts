import { describe, expect, it } from "vitest";
import type { UserComposerAttachment } from "@/attachments/types";
import {
  buildPromptStashScopeKey,
  collectStashAttachmentIds,
  countOtherScopeEntries,
  MAX_STASH_ENTRIES_PER_QUEUE,
  mergeHydratedPromptStashQueues,
  mergeStashRestoreAttachments,
  mergeStashRestoreText,
  PROMPT_STASH_UNSCOPED_KEY,
  stashEntryInQueues,
  takeEntryFromQueues,
  type PromptStashEntry,
  type PromptStashQueues,
} from "./state";

function makeImageAttachment(id: string): UserComposerAttachment {
  return {
    kind: "image",
    metadata: {
      id,
      mimeType: "image/png",
      storageType: "web-indexeddb",
      storageKey: id,
      createdAt: 0,
    },
  };
}

function makeEntry(input: {
  id: string;
  provider?: string | null;
  text?: string;
  attachments?: UserComposerAttachment[];
}): PromptStashEntry {
  return {
    id: input.id,
    createdAt: 1_700_000_000_000,
    text: input.text ?? `prompt ${input.id}`,
    attachments: input.attachments ?? [],
    provider: input.provider === undefined ? "claude" : input.provider,
  };
}

describe("buildPromptStashScopeKey", () => {
  it("maps a provider to its own bucket and null to the unscoped bucket", () => {
    expect(buildPromptStashScopeKey("claude")).toBe("provider:claude");
    expect(buildPromptStashScopeKey(null)).toBe(PROMPT_STASH_UNSCOPED_KEY);
    expect(buildPromptStashScopeKey(undefined)).toBe(PROMPT_STASH_UNSCOPED_KEY);
  });

  it("namespaces provider keys so they can never equal the unscoped sentinel", () => {
    expect(buildPromptStashScopeKey("__none__")).not.toBe(PROMPT_STASH_UNSCOPED_KEY);
  });
});

describe("stashEntryInQueues", () => {
  it("prepends entries so the newest stash is first", () => {
    let queues: PromptStashQueues = {};
    queues = stashEntryInQueues(queues, makeEntry({ id: "first" })).queues;
    queues = stashEntryInQueues(queues, makeEntry({ id: "second" })).queues;
    expect(queues["provider:claude"]?.map((entry) => entry.id)).toEqual(["second", "first"]);
  });

  it("scopes queues by provider, including the unscoped bucket", () => {
    let queues: PromptStashQueues = {};
    queues = stashEntryInQueues(queues, makeEntry({ id: "claude" })).queues;
    queues = stashEntryInQueues(queues, makeEntry({ id: "codex", provider: "codex" })).queues;
    queues = stashEntryInQueues(queues, makeEntry({ id: "none", provider: null })).queues;
    expect(queues["provider:claude"]?.map((entry) => entry.id)).toEqual(["claude"]);
    expect(queues["provider:codex"]?.map((entry) => entry.id)).toEqual(["codex"]);
    expect(queues[PROMPT_STASH_UNSCOPED_KEY]?.map((entry) => entry.id)).toEqual(["none"]);
  });

  it("evicts the oldest entry past the per-queue cap and returns it", () => {
    let queues: PromptStashQueues = {};
    for (let index = 0; index < MAX_STASH_ENTRIES_PER_QUEUE; index += 1) {
      const result = stashEntryInQueues(queues, makeEntry({ id: `entry-${index}` }));
      expect(result.evicted).toBeNull();
      queues = result.queues;
    }
    const { queues: next, evicted } = stashEntryInQueues(queues, makeEntry({ id: "overflow" }));
    expect(evicted?.id).toBe("entry-0");
    expect(next["provider:claude"]).toHaveLength(MAX_STASH_ENTRIES_PER_QUEUE);
    expect(next["provider:claude"]?.[0]?.id).toBe("overflow");
  });
});

describe("mergeHydratedPromptStashQueues", () => {
  it("retains a stash made before hydration alongside persisted entries", () => {
    const persisted = stashEntryInQueues({}, makeEntry({ id: "persisted" })).queues;
    const current = stashEntryInQueues({}, makeEntry({ id: "new" })).queues;

    expect(
      mergeHydratedPromptStashQueues(persisted, current)["provider:claude"]?.map(({ id }) => id),
    ).toEqual(["new", "persisted"]);
  });
});

describe("takeEntryFromQueues", () => {
  it("removes and returns the entry; a second take returns null", () => {
    let queues: PromptStashQueues = {};
    queues = stashEntryInQueues(queues, makeEntry({ id: "keep" })).queues;
    queues = stashEntryInQueues(queues, makeEntry({ id: "take" })).queues;

    const first = takeEntryFromQueues(queues, "provider:claude", "take");
    expect(first.entry?.id).toBe("take");
    const second = takeEntryFromQueues(first.queues, "provider:claude", "take");
    expect(second.entry).toBeNull();
    expect(second.queues["provider:claude"]?.map((entry) => entry.id)).toEqual(["keep"]);
  });

  it("drops the scope key entirely when its queue empties", () => {
    const queues = stashEntryInQueues({}, makeEntry({ id: "only" })).queues;
    const { queues: next } = takeEntryFromQueues(queues, "provider:claude", "only");
    expect(next["provider:claude"]).toBeUndefined();
  });

  // Queue keys are persisted as plain strings, so a hand-edited or corrupted
  // storage payload can carry a literal `__proto__` key that survives
  // JSON.parse as an own property. An unguarded lookup would resolve to
  // Object.prototype and throw on iteration.
  it("tolerates a __proto__ scope key rehydrated from storage", () => {
    const queues = JSON.parse('{"__proto__":[]}') as PromptStashQueues;
    expect(() => takeEntryFromQueues(queues, "__proto__", "missing")).not.toThrow();
    expect(takeEntryFromQueues(queues, "__proto__", "missing").entry).toBeNull();
  });
});

describe("countOtherScopeEntries", () => {
  it("counts entries stashed under every other scope", () => {
    let queues: PromptStashQueues = {};
    queues = stashEntryInQueues(queues, makeEntry({ id: "a" })).queues;
    queues = stashEntryInQueues(queues, makeEntry({ id: "b", provider: "codex" })).queues;
    queues = stashEntryInQueues(queues, makeEntry({ id: "c", provider: "codex" })).queues;
    expect(countOtherScopeEntries(queues, "provider:claude")).toBe(2);
    expect(countOtherScopeEntries(queues, "provider:codex")).toBe(1);
  });
});

describe("collectStashAttachmentIds", () => {
  it("collects image ids across every queue and ignores other kinds", () => {
    let queues: PromptStashQueues = {};
    queues = stashEntryInQueues(
      queues,
      makeEntry({ id: "a", attachments: [makeImageAttachment("img-1")] }),
    ).queues;
    queues = stashEntryInQueues(
      queues,
      makeEntry({
        id: "b",
        provider: "codex",
        attachments: [
          makeImageAttachment("img-2"),
          { kind: "workspace_file", path: "src/app.ts", selection: { kind: "whole_file" } },
        ],
      }),
    ).queues;
    expect(collectStashAttachmentIds(queues)).toEqual(new Set(["img-1", "img-2"]));
  });
});

describe("mergeStashRestoreText", () => {
  it("returns the stashed text when the composer is empty", () => {
    expect(mergeStashRestoreText("", "stashed")).toBe("stashed");
  });

  it("appends after a blank line when the composer already has text", () => {
    expect(mergeStashRestoreText("typing here\n", "stashed")).toBe("typing here\n\nstashed");
  });

  it("leaves the composer untouched for an attachment-only entry", () => {
    expect(mergeStashRestoreText("typing here", "")).toBe("typing here");
  });
});

describe("mergeStashRestoreAttachments", () => {
  it("appends restored attachments and skips duplicates", () => {
    const existing = makeImageAttachment("img-1");
    const workspaceFile: UserComposerAttachment = {
      kind: "workspace_file",
      path: "src/app.ts",
      selection: { kind: "whole_file" },
    };
    const merged = mergeStashRestoreAttachments(
      [existing],
      [makeImageAttachment("img-1"), makeImageAttachment("img-2"), workspaceFile],
    );
    expect(merged.map((attachment) => attachmentLabel(attachment))).toEqual([
      "image:img-1",
      "image:img-2",
      "workspace_file:src/app.ts",
    ]);
  });
});

function attachmentLabel(attachment: UserComposerAttachment): string {
  if (attachment.kind === "image") {
    return `image:${attachment.metadata.id}`;
  }
  if (attachment.kind === "workspace_file") {
    return `workspace_file:${attachment.path}`;
  }
  return attachment.kind;
}

import { describe, expect, it } from "vitest";
import {
  detectMentionTrigger,
  expandMentions,
  filterChannelsByQuery,
  filterMembersByQuery,
  preprocessMarkdown,
} from "./mentions";
import type { ChatChannel, ChatMember } from "@/api/chat";

function member(partial: Partial<ChatMember>): ChatMember {
  return {
    userId: "u",
    role: "member",
    joinedAt: "",
    name: "User",
    email: "user@x",
    image: null,
    ...partial,
  };
}

function channel(partial: Partial<ChatChannel>): ChatChannel {
  return {
    id: "c",
    orgId: "o",
    name: null,
    topic: null,
    kind: "public",
    createdBy: "u",
    createdAt: "",
    archivedAt: null,
    memberCount: 0,
    isMember: false,
    ...partial,
  };
}

describe("expandMentions", () => {
  it("expands user and channel tokens to bold markdown", () => {
    const out = expandMentions("hey <@u1> in <#c1>", {
      membersById: new Map([["u1", member({ userId: "u1", name: "Alice" })]]),
      channelsById: new Map([["c1", channel({ id: "c1", name: "general" })]]),
    });
    expect(out).toBe("hey **@Alice** in **#general**");
  });

  it("leaves unknown ids as-is", () => {
    const out = expandMentions("hi <@ghost> and <#nowhere>", {
      membersById: new Map(),
      channelsById: new Map(),
    });
    expect(out).toBe("hi <@ghost> and <#nowhere>");
  });
});

describe("detectMentionTrigger", () => {
  it("detects @ at start of line", () => {
    expect(detectMentionTrigger("@ali", 4)).toMatchObject({
      kind: "@",
      query: "ali",
    });
  });
  it("detects # after space", () => {
    expect(detectMentionTrigger("go #gen", 7)).toMatchObject({
      kind: "#",
      query: "gen",
    });
  });
  it("ignores @ in the middle of a word (email-like)", () => {
    expect(detectMentionTrigger("foo@bar", 7)).toBeNull();
  });
  it("returns null when caret is past a space after trigger", () => {
    expect(detectMentionTrigger("@ali some", 9)).toBeNull();
  });
});

describe("filterMembersByQuery", () => {
  const people = [
    member({ userId: "1", name: "Alice", email: "alice@x" }),
    member({ userId: "2", name: "Bob", email: "bob@y" }),
    member({ userId: "3", name: "Charlie", email: "chuck@z" }),
  ];
  it("prioritizes name startsWith", () => {
    const out = filterMembersByQuery(people, "al");
    expect(out[0]?.userId).toBe("1");
  });
  it("also matches email", () => {
    const out = filterMembersByQuery(people, "chuck");
    expect(out[0]?.userId).toBe("3");
  });
  it("returns all with empty query up to limit", () => {
    expect(filterMembersByQuery(people, "", 2)).toHaveLength(2);
  });
});

describe("filterChannelsByQuery", () => {
  it("skips DMs and unnamed", () => {
    const channels = [
      channel({ id: "a", name: "general", kind: "public" }),
      channel({ id: "b", name: null, kind: "dm" }),
      channel({ id: "c", name: "random", kind: "public" }),
    ];
    const out = filterChannelsByQuery(channels, "gen");
    expect(out.map((c) => c.id)).toEqual(["a"]);
  });
});

describe("preprocessMarkdown", () => {
  const maps = { membersById: new Map(), channelsById: new Map() };

  it("renders task list markers with ☐ / ☑", () => {
    const out = preprocessMarkdown(
      ["- [ ] todo one", "- [x] done two", "- [X] done three"].join("\n"),
      maps,
    );
    expect(out).toContain("- ☐ todo one");
    expect(out).toContain("- ☑ done two");
    expect(out).toContain("- ☑ done three");
  });

  it("redacts spoilers with block glyphs of comparable width", () => {
    const out = preprocessMarkdown("hi ||secret|| world", maps);
    expect(out).not.toContain("secret");
    expect(out).toMatch(/▓+/);
    expect(out.startsWith("hi ")).toBe(true);
    expect(out.endsWith(" world")).toBe(true);
  });

  it("does not mangle mentions when applying other rules", () => {
    const out = preprocessMarkdown("hi <@u1> ||hide me||", {
      membersById: new Map([["u1", { name: "Alice" } as never]]),
      channelsById: new Map(),
    });
    expect(out).toContain("**@Alice**");
    expect(out).toMatch(/▓+/);
  });
});

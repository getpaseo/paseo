import { describe, expect, test } from "vitest";
import type { InboxItem } from "@/leitstand/inbox-model";
import { isLeitstandPathname } from "@/utils/host-routes";
import { projectSidebarInbox } from "./sidebar-leiste-model";

function question(id: string): InboxItem {
  return {
    kind: "question",
    id,
    serverId: "host",
    sessionKey: `host:${id}`,
    workspaceId: id,
    projectName: "app",
    title: `Session ${id}`,
    since: null,
  };
}

describe("isLeitstandPathname", () => {
  test("marks the Leitstand route and its host-scoped alias", () => {
    expect(isLeitstandPathname("/open-project")).toBe(true);
    expect(isLeitstandPathname("/h/local/open-project")).toBe(true);
  });

  test("leaves workspaces, settings and the other sidebar routes alone", () => {
    expect(isLeitstandPathname("/")).toBe(false);
    expect(isLeitstandPathname("/sessions")).toBe(false);
    expect(isLeitstandPathname("/settings/appearance")).toBe(false);
    expect(isLeitstandPathname("/h/local/workspace/ws-1")).toBe(false);
    expect(isLeitstandPathname("/h/local/open-project/extra")).toBe(false);
  });
});

describe("projectSidebarInbox", () => {
  const items = ["a", "b", "c"].map(question);

  test("hides the section when nothing needs you", () => {
    expect(projectSidebarInbox({ items: [], isLeitstandOpen: false })).toBeNull();
  });

  test("hides the section while the Leitstand shows the full inbox", () => {
    expect(projectSidebarInbox({ items, isLeitstandOpen: true })).toBeNull();
  });

  test("shows every item up to the limit, in inbox order", () => {
    const projection = projectSidebarInbox({ items, isLeitstandOpen: false });
    expect(projection?.rows.map((item) => item.id)).toEqual(["a", "b", "c"]);
    expect(projection?.hiddenCount).toBe(0);
  });

  test("counts what the limit cuts off", () => {
    const projection = projectSidebarInbox({ items, isLeitstandOpen: false, limit: 2 });
    expect(projection?.rows.map((item) => item.id)).toEqual(["a", "b"]);
    expect(projection?.hiddenCount).toBe(1);
  });
});

import { describe, expect, it } from "vitest";
import { createEntityRefs } from "./refs.js";

describe("session entity references", () => {
  it("interns frozen references separately by kind, host and entity", () => {
    const refs = createEntityRefs();
    for (const reference of [refs.workspace, refs.agent, refs.project, refs.terminal]) {
      const first = reference("host", "entity");
      expect(reference("host", "entity")).toBe(first);
      expect(Object.isFrozen(first)).toBe(true);
      expect(reference("other", "entity")).not.toBe(first);
      expect(reference("host", "other")).not.toBe(first);
    }
    expect(refs.workspace("host", "entity")).not.toBe(refs.agent("host", "entity"));
  });

  it("keeps opaque ids unambiguous and interning scoped to one app session", () => {
    const refs = createEntityRefs();
    expect(refs.workspace("a:b", "c").key).not.toBe(refs.workspace("a", "b:c").key);
    expect(createEntityRefs().workspace("host", "entity")).not.toBe(
      refs.workspace("host", "entity"),
    );
  });
});
